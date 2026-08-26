import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { createDefaultSelectionContract } from "./candidate-selection.js";
import { DEFAULT_CANDIDATE_SET_BUDGET } from "./candidate-set.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";

const agentIdParams = z.object({ id: z.string().uuid() });
const runIdParams = z.object({ id: z.string().uuid() });
const candidateSetIdParams = z.object({ id: z.string().uuid() });
const assuranceProposalIdParams = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
});
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});
const repairBody = z.object({
  objective: z.string().trim().min(1).max(2_000).optional(),
});
const selectionCriterionBody = z
  .object({
    kind: z.enum([
      "quality-assertion",
      "changed-files",
      "added-bytes",
      "latency-ms",
      "total-tokens",
    ]),
    source: z.enum([
      "trusted-validation-evaluator",
      "workspace-change-evidence",
      "monotonic-execution-measurement",
      "runtime-usage-response",
    ]),
    direction: z.enum(["maximize", "minimize"]),
    maximum: z.number().int().nonnegative(),
    evaluatorVersion: z.string().min(1).max(80),
  })
  .strict();
const candidateSetBody = z
  .object({
    objective: z.string().trim().min(1).max(50_000),
    competitors: z
      .array(
        z
          .object({
            id: z
              .string()
              .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/),
            executorProfileId: z.literal("standard-v1"),
            strategyInstruction: z.string().trim().min(1).max(4_000),
          })
          .strict(),
      )
      .min(2)
      .max(8),
    selectionContract: z
      .object({
        schemaVersion: z.literal(1),
        criteria: z.array(selectionCriterionBody).min(1).max(5),
      })
      .strict()
      .default(createDefaultSelectionContract()),
    maxConcurrency: z.number().int().min(1).max(4).default(2),
    budget: z
      .object({
        maxDurationMsPerCompetitor: z.number().int().min(1_000).max(3_600_000),
        maxTotalTokens: z.number().int().min(1).max(10_000_000),
        maxTotalChangedBytes: z.number().int().min(0).max(800_000_000),
      })
      .strict()
      .default(DEFAULT_CANDIDATE_SET_BUDGET),
    loserPolicy: z.enum(["retain", "discard"]).default("retain"),
  })
  .strict();
const contractName = z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_.-]+$/);
const outcomeContractBody = z.object({
  requiredPaths: z.array(z.string().trim().min(1).max(240)).max(100),
  protectedPaths: z.array(z.string().trim().min(1).max(240)).max(100),
  maxChangedFiles: z.number().int().min(1).max(10_000),
  maxAddedBytes: z.number().int().min(0).max(1_073_741_824),
  secretPatterns: z
    .array(
      z.object({
        name: contractName,
        pattern: z.string().min(1).max(1_000),
      }),
    )
    .max(50),
  validationCommands: z
    .array(
      z.object({
        name: contractName,
        command: z.string().trim().min(1).max(2_000),
        required: z.boolean(),
        timeoutMs: z.number().int().min(1_000).max(300_000),
      }),
    )
    .max(20),
});
const assuranceDecisionBody = z
  .object({
    reason: z.string().trim().max(500).default(""),
  })
  .strict();
const outcomeContractRollbackBody = z
  .object({
    targetVersion: z.number().int().min(1),
    expectedCurrentVersion: z.number().int().min(1),
  })
  .strict();

export async function createApp(
  config: AppConfig,
  service: AgentService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      !config.authToken ||
      !request.url.startsWith("/api/") ||
      request.url === "/api/health" ||
      request.url === "/api/auth"
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/effects", async () => ({
    effects: await service.listExternalEffects(),
  }));

  app.get("/api/agents", async () => ({ agents: service.listAgents() }));

  app.post("/api/agents", async (request, reply) => {
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(body);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(id, body) };
  });

  app.put("/api/agents/:id/outcome-contract", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = outcomeContractBody.parse(request.body);
    return {
      outcomeContract: await service.updateOutcomeContract(id, body),
    };
  });

  app.get("/api/agents/:id/outcome-contract/versions", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { versions: service.listOutcomeContractVersions(id) };
  });

  app.post("/api/agents/:id/outcome-contract/rollback", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    const body = outcomeContractRollbackBody.parse(request.body);
    return {
      outcomeContract: await service.rollbackOutcomeContract(
        id,
        body.targetVersion,
        body.expectedCurrentVersion,
      ),
    };
  });

  app.get("/api/agents/:id/assurance-proposals", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { proposals: service.listAssuranceProposals(id) };
  });

  app.post("/api/agents/:id/assurance-proposals/derive", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { proposal: await service.deriveAssuranceProposal(id) };
  });

  app.post("/api/assurance-proposals/:id/accept", async (request) => {
    const { id } = assuranceProposalIdParams.parse(request.params);
    const body = assuranceDecisionBody.parse(request.body ?? {});
    return service.acceptAssuranceProposal(id, body.reason);
  });

  app.post("/api/assurance-proposals/:id/reject", async (request) => {
    const { id } = assuranceProposalIdParams.parse(request.params);
    const body = assuranceDecisionBody.parse(request.body ?? {});
    return { proposal: await service.rejectAssuranceProposal(id, body.reason) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(id) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { messages: service.getMessages(id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(id) };
  });

  app.get("/api/agents/:id/candidate-sets", async (request) => {
    const { id } = agentIdParams.parse(request.params);
    return { candidateSets: service.getCandidateSets(id) };
  });

  app.post("/api/agents/:id/candidate-sets", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = candidateSetBody.parse(request.body);
    return reply.code(202).send(await service.createCandidateSet(id, body));
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(id, body.content);
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(id) };
  });

  app.get("/api/candidate-sets/:id", async (request) => {
    const { id } = candidateSetIdParams.parse(request.params);
    return { candidateSet: service.getCandidateSet(id) };
  });

  app.post("/api/candidate-sets/:id/cancel", async (request) => {
    const { id } = candidateSetIdParams.parse(request.params);
    return { candidateSet: await service.cancelCandidateSet(id) };
  });

  app.post("/api/runs/:id/repair", async (request, reply) => {
    const { id } = runIdParams.parse(request.params);
    const body = repairBody.parse(request.body ?? {});
    return reply.code(202).send(await service.repairRun(id, body.objective));
  });

  app.post("/api/runs/:id/discard", async (request) => {
    const { id } = runIdParams.parse(request.params);
    return { run: await service.discardRun(id) };
  });

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    const validationError = error instanceof z.ZodError;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: appError.message,
      ...(validationError ? { details: error.issues } : {}),
    });
  });

  return app;
}
