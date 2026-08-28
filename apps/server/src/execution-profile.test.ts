import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { buildExecutionProfileEvidence } from "./execution-profile.js";

describe("execution profile evidence", () => {
  it("attests ModelArk execution without exposing credentials or endpoint identity", () => {
    const evidence = buildExecutionProfileEvidence(
      loadConfig({
        NODE_ENV: "test",
        ARK_API_KEY: "ark-private-key",
        ARK_MODEL: "ep-private-endpoint",
        ARK_BASE_URL: "https://ark.ap-southeast.bytepluses.com/api/v3",
        RUNTIME_PROVIDER: "container",
      }),
    );
    const serialized = JSON.stringify(evidence);
    const expectedCommitment =
      "sha256:" +
      createHash("sha256").update("ep-private-endpoint").digest("hex");

    expect(evidence).toMatchObject({
      name: "execution-profile",
      status: "passed",
      required: true,
    });
    expect(evidence.summary).toContain("configured ModelArk Responses profile");
    expect(evidence.output).toContain(expectedCommitment);
    expect(serialized).not.toMatch(
      /ark-private-key|ep-private-endpoint|ark\.ap-southeast\.bytepluses\.com/,
    );
  });

  it("binds fresh generated-output preflight facts into live judge evidence", () => {
    const model = "ep-private-endpoint";
    const endpointOrigin = "https://ark.ap-southeast.bytepluses.com";
    const evidence = buildExecutionProfileEvidence(
      loadConfig({
        NODE_ENV: "test",
        HOST: "127.0.0.1",
        AIRLOCK_MODELARK_DEMO_MODE: "true",
        AIRLOCK_MODELARK_PREFLIGHT_PROOF: JSON.stringify({
          schema: "agent-airlock/modelark-preflight-proof",
          schemaVersion: 1,
          checkedAt: new Date().toISOString(),
          generatedAssistantOutput: true,
          modelCommitment:
            "sha256:" + createHash("sha256").update(model).digest("hex"),
          endpointOriginCommitment:
            "sha256:" +
            createHash("sha256").update(endpointOrigin).digest("hex"),
          attemptCount: 2,
          requestCount: 4,
          retryDelayMs: 4_000,
        }),
        ARK_API_KEY: "ark-private-key",
        ARK_MODEL: model,
        ARK_BASE_URL: endpointOrigin + "/api/v3",
        RUNTIME_PROVIDER: "container",
        CODEX_BIN: "codex",
      }),
    );
    const output = JSON.parse(evidence.output ?? "");

    expect(evidence.summary).toContain(
      "fresh provider preflight generated assistant output in 4 bounded requests",
    );
    expect(output.preflight).toMatchObject({
      generatedAssistantOutput: true,
      attemptCount: 2,
      requestCount: 4,
      retryDelayMs: 4_000,
    });
    expect(JSON.stringify(evidence)).not.toMatch(
      /ark-private-key|ep-private-endpoint|ark\.ap-southeast\.bytepluses\.com/,
    );
  });

  it("labels the local protocol fixture honestly", () => {
    const evidence = buildExecutionProfileEvidence(
      loadConfig({
        NODE_ENV: "test",
        HOST: "127.0.0.1",
        AIRLOCK_PROTOCOL_FIXTURE_MODE: "true",
        RUNTIME_PROVIDER: "container",
        CONTAINER_ENGINE: "docker",
        CODEX_BIN: "codex",
        ARK_API_KEY: "deterministic-protocol-fixture",
        ARK_MODEL: "protocol-fixture",
        ARK_BASE_URL: "http://host.docker.internal:43123/v1",
      }),
    );

    expect(evidence.summary).toContain("local Responses protocol fixture");
    expect(evidence.summary).not.toContain("configured ModelArk");
  });
});
