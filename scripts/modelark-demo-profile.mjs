import os from "node:os";
import path from "node:path";

export const liveModelArkAgentName = "Live ModelArk Proof";
export const liveModelArkAgentDescription =
  "Provider-backed inference, isolated Candidate, validated Promotion";
export const liveModelArkAgentInstructions =
  "Work only in isolated Candidate State. Complete the requested workspace, SQLite, and deferred-action changes, run the required verification, and report the observed result.";
export const liveModelArkPrompt =
  "Create modelark-proof.txt containing exactly modelark-live followed by a newline. Then use Node.js built-in node:sqlite to update the inventory row with id demo in .airlock/demo.sqlite so value is modelark-live and updated_at is 2026-08-28T00:00:00.000Z. Append exactly one demo.notification.requested JSON object to AIRLOCK_OUTBOX_PATH with id modelark-live-ready, destination demo-console, subject ModelArk release ready, and body The live Whole-Agent Candidate passed. Use no dependencies. Verify the file and database values before finishing.";

const liveStateValidationCommand = [
  'test "$(cat modelark-proof.txt)" = modelark-live',
  "node --no-warnings --experimental-sqlite --input-type=module -e 'import { DatabaseSync } from \"node:sqlite\"; const database = new DatabaseSync(\".airlock/demo.sqlite\"); const row = database.prepare(\"SELECT value, updated_at FROM inventory WHERE id = ?\").get(\"demo\"); database.close(); if (row?.value !== \"modelark-live\" || row?.updated_at !== \"2026-08-28T00:00:00.000Z\") process.exit(1);'",
].join(" && ");

export const liveModelArkContract = Object.freeze({
  requiredPaths: ["AGENTS.md", "modelark-proof.txt"],
  protectedPaths: ["AGENTS.md"],
  maxChangedFiles: 4,
  maxAddedBytes: 65_536,
  secretPatterns: [
    {
      name: "ark-api-key-assignment",
      pattern: "ARK_API_KEY\\s*[:=]\\s*['\\\"]?[^\\s'\\\"]{8,}",
    },
    {
      name: "ark-model-api-key",
      pattern:
        "\\bark-[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}-[A-Za-z0-9]{4,}\\b",
    },
    {
      name: "bearer-token",
      pattern: "Bearer\\s+[A-Za-z0-9._~+/-]{12,}=*",
    },
  ],
  validationCommands: [
    {
      name: "modelark-live-state",
      command: liveStateValidationCommand,
      required: true,
      timeoutMs: 10_000,
    },
  ],
});

export function assertSafeManagedRoot(projectRoot, stateRoot) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedStateRoot = path.resolve(stateRoot);
  const forbidden = new Set([
    path.parse(resolvedStateRoot).root,
    resolvedProjectRoot,
    os.homedir(),
  ]);
  if (forbidden.has(resolvedStateRoot) || path.dirname(resolvedStateRoot) === resolvedStateRoot) {
    throw new Error("Refusing to use an unsafe ModelArk demo data root: " + resolvedStateRoot);
  }
  return resolvedStateRoot;
}

export function comparableContract(contract) {
  return {
    requiredPaths: contract.requiredPaths,
    protectedPaths: contract.protectedPaths,
    maxChangedFiles: contract.maxChangedFiles,
    maxAddedBytes: contract.maxAddedBytes,
    secretPatterns: contract.secretPatterns,
    validationCommands: contract.validationCommands,
  };
}

export function buildLiveModelArkDemoEnvironment(
  baseEnvironment,
  { host, port, stateRoot },
) {
  return {
    ...baseEnvironment,
    HOST: host,
    PORT: String(port),
    LOCAL_POC_DATA_ROOT: stateRoot,
    AIRLOCK_DEMO_MODE: "false",
    AIRLOCK_PROTOCOL_FIXTURE_MODE: "false",
    AIRLOCK_MODELARK_DEMO_MODE: "true",
    AIRLOCK_SKIP_MODELARK_PREFLIGHT: "false",
    RUNTIME_PROVIDER: "container",
    CODEX_BIN: "codex",
    RUNTIME_INSTANCE_ID: "airlock-modelark-demo",
  };
}

async function requestJson(baseUrl, pathname, options, fetchImpl) {
  const response = await fetchImpl(baseUrl + pathname, {
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${pathname}`);
  return response.json();
}

export async function seedLiveModelArkDemo(baseUrl, fetchImpl = fetch) {
  const { agents } = await requestJson(baseUrl, "/api/agents", {}, fetchImpl);
  const matches = agents.filter((agent) => agent.name === liveModelArkAgentName);
  if (matches.length > 1) {
    throw new Error("The managed demo contains duplicate Live ModelArk Proof Agents");
  }
  let agent = matches[0];
  if (!agent) {
    ({ agent } = await requestJson(
      baseUrl,
      "/api/agents",
      {
        method: "POST",
        body: JSON.stringify({
          name: liveModelArkAgentName,
          description: liveModelArkAgentDescription,
          instructions: liveModelArkAgentInstructions,
        }),
      },
      fetchImpl,
    ));
    await requestJson(
      baseUrl,
      `/api/agents/${agent.id}/outcome-contract`,
      {
        method: "PUT",
        body: JSON.stringify(liveModelArkContract),
      },
      fetchImpl,
    );
    return agent;
  }
  if (
    agent.description !== liveModelArkAgentDescription ||
    agent.instructions !== liveModelArkAgentInstructions ||
    JSON.stringify(comparableContract(agent.outcomeContract)) !==
    JSON.stringify(liveModelArkContract)
  ) {
    throw new Error(
      "The Live ModelArk Proof Agent profile or Outcome Contract changed. Restart with --reset for the guaranteed judge path.",
    );
  }
  return agent;
}
