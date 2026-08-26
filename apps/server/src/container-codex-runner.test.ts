import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  buildContainerRunArgs,
  containerName,
} from "./container-codex-runner.js";

describe("Container Codex runner", () => {
  it("builds an isolated Docker/Podman-compatible invocation", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "secret-that-must-not-appear-in-argv",
      ARK_MODEL: "ep-test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CONTAINER_USER: "501:20",
      RUNTIME_INSTANCE_ID: "test-instance",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent/unsafe",
        workspacePath: "/tmp/agent-workspace",
        codexHomePath: "/tmp/candidate-codex-home",
        outboxPath: "/tmp/candidate-outbox/intents.jsonl",
        repairReferencePath: "/tmp/candidate/repair-reference",
        resourceBindings: [
          {
            providerId: "acceptance-object",
            hostPath: "/tmp/candidate/resources/acceptance-object/object.json",
            runtimePath: "/airlock/resources/acceptance-object/object.json",
            access: "read-write",
          },
          {
            providerId: "policy-bundle",
            hostPath: "/tmp/candidate/resources/policy-bundle/policy.json",
            runtimePath: "/airlock/resources/policy-bundle/policy.json",
            access: "read-only",
          },
        ],
        prompt: "write a small program",
        threadId: null,
      },
      config,
    );

    expect(containerName("agent/unsafe", "test-instance")).toBe(
      "launchpad-test-instance-agent-unsafe",
    );
    expect(args).toContain("runtime:test");
    expect(args).toContain("type=bind,src=/tmp/agent-workspace,dst=/workspace");
    expect(args).toContain("type=bind,src=/tmp/candidate-codex-home,dst=/codex-home");
    expect(args).toContain("type=bind,src=/tmp/candidate-outbox,dst=/airlock-outbox");
    expect(args).not.toContain("type=bind,src=/tmp/codex-home,dst=/codex-home");
    expect(args).toContain("501:20");
    expect(args).toContain("workspace-write");
    expect(args).toContain("/workspace");
    expect(args).toContain("/airlock-outbox");
    expect(args).toContain(
      "type=bind,src=/tmp/candidate/repair-reference,dst=/airlock-repair-reference,readonly",
    );
    expect(args).toContain("AIRLOCK_REPAIR_REFERENCE_PATH=/airlock-repair-reference");
    expect(args).toContain("/airlock-repair-reference");
    expect(args).toContain(
      "AIRLOCK_RESOURCE_ACCEPTANCE_OBJECT_PATH=/airlock/resources/acceptance-object/object.json",
    );
    expect(args).toContain(
      "AIRLOCK_RESOURCE_POLICY_BUNDLE_PATH=/airlock/resources/policy-bundle/policy.json",
    );
    expect(args).toContain(
      "type=bind,src=/tmp/candidate/resources/acceptance-object/object.json,dst=/airlock/resources/acceptance-object/object.json",
    );
    expect(args).toContain(
      "type=bind,src=/tmp/candidate/resources/policy-bundle/policy.json,dst=/airlock/resources/policy-bundle/policy.json,readonly",
    );
    expect(args).toContain(
      "/airlock/resources/acceptance-object/object.json",
    );
    expect(args).toContain("/airlock/resources/policy-bundle/policy.json");
    expect(args).not.toContain(
      "AIRLOCK_RESOURCE_ACCEPTANCE_OBJECT_PATH=/tmp/candidate/resources/acceptance-object/object.json",
    );
    expect(args).toContain("io.codejam.instance-id=test-instance");
    expect(args).toContain("keep-id");
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
    expect(args.join(" ")).not.toContain("mock-deliveries");
  });

  it("resumes a thread inside the mounted Runtime workspace", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        codexHomePath: "/tmp/candidate-codex-home",
        outboxPath: "/tmp/candidate-outbox/intents.jsonl",
        prompt: "continue",
        threadId: "thread-123",
      },
      config,
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "continue"]);
    expect(args).not.toContain("keep-id");
  });
});
