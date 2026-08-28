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
