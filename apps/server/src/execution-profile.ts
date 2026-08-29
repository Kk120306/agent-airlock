import { createHash } from "node:crypto";
import type { AppConfig } from "./config.js";
import { isArkConfigured } from "./config.js";
import type { ValidationEvidence } from "./types.js";

interface ExecutionProfileAttestation {
  schemaVersion: 2;
  attestation: "airlock-control-plane";
  inferenceMode:
    | "deterministic-local-fixture"
    | "local-responses-protocol-fixture"
    | "modelark"
    | "unconfigured";
  executor: "deterministic-fixture" | "codex-cli";
  runtimeProvider: "local-process" | "container";
  providerProtocol: "responses";
  modelCommitment: string;
  preflight: {
    checkedAt: string;
    generatedAssistantOutput: true;
    endpointOriginCommitment: string;
    attemptCount: number;
    requestCount: number;
    retryDelayMs: number;
  } | null;
}

export const EXECUTION_PROFILE_VALIDATION_NAME = "execution-profile";

export function buildExecutionProfileEvidence(
  config: AppConfig,
): ValidationEvidence {
  const inferenceMode: ExecutionProfileAttestation["inferenceMode"] =
    config.demoMode
      ? "deterministic-local-fixture"
      : config.protocolFixtureMode
        ? "local-responses-protocol-fixture"
        : isArkConfigured(config)
          ? "modelark"
          : "unconfigured";
  const attestation: ExecutionProfileAttestation = {
    schemaVersion: 2,
    attestation: "airlock-control-plane",
    inferenceMode,
    executor: config.demoMode ? "deterministic-fixture" : "codex-cli",
    runtimeProvider: config.runtimeProvider,
    providerProtocol: "responses",
    modelCommitment:
      "sha256:" + createHash("sha256").update(config.arkModel).digest("hex"),
    preflight: config.modelArkPreflightProof
      ? {
          checkedAt: config.modelArkPreflightProof.checkedAt,
          generatedAssistantOutput: true,
          endpointOriginCommitment:
            config.modelArkPreflightProof.endpointOriginCommitment,
          attemptCount: config.modelArkPreflightProof.attemptCount,
          requestCount: config.modelArkPreflightProof.requestCount,
          retryDelayMs: config.modelArkPreflightProof.retryDelayMs,
        }
      : null,
  };
  const profileLabel = {
    "deterministic-local-fixture": "the deterministic local fixture",
    "local-responses-protocol-fixture":
      "real Codex CLI against the local Responses protocol fixture",
    modelark: "real Codex CLI against the configured ModelArk Responses profile",
    unconfigured: "an unconfigured inference profile",
  }[inferenceMode];

  return {
    name: EXECUTION_PROFILE_VALIDATION_NAME,
    status: "passed",
    required: true,
    summary:
      (attestation.preflight
        ? `A fresh provider preflight generated assistant output in ${attestation.preflight.requestCount} bounded request${attestation.preflight.requestCount === 1 ? "" : "s"}. `
        : "") +
      "Airlock control plane attested successful execution through " +
      profileLabel +
      ". Model identity is committed without disclosure as " +
      shortCommitment(attestation.modelCommitment) +
      ".",
    durationMs: 0,
    output: JSON.stringify(attestation, null, 2),
  };
}

function shortCommitment(commitment: string): string {
  return commitment.slice(0, "sha256:".length + 12);
}
