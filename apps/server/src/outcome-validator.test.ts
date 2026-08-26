import { access, cp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createDefaultOutcomeContract } from "./outcome-contract.js";
import { OutcomeValidator } from "./outcome-validator.js";
import type {
  ValidationCommandExecutor,
  ValidationCommandResult,
} from "./validation-command-runner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

class FixtureExecutor implements ValidationCommandExecutor {
  constructor(
    private readonly result: (
      name: string,
      workspacePath: string,
    ) => ValidationCommandResult | Promise<ValidationCommandResult>,
  ) {}

  async execute(
    _workspacePath: string,
    command: { name: string },
    _runId: string,
  ): Promise<ValidationCommandResult> {
    return this.result(command.name, _workspacePath);
  }
}

const passingResult = (output = "ok\n"): ValidationCommandResult => ({
  exitCode: 0,
  output,
  durationMs: 4,
  timedOut: false,
  outputExceeded: false,
});

async function makeWorkspaces(): Promise<{ canonical: string; candidate: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "airlock-outcome-validator-"));
  temporaryDirectories.push(root);
  const canonical = path.join(root, "canonical");
  const candidate = path.join(root, "candidate");
  await mkdir(canonical, { recursive: true });
  await writeFile(path.join(canonical, "AGENTS.md"), "protected\n");
  await writeFile(path.join(canonical, "README.md"), "required\n");
  await cp(canonical, candidate, { recursive: true });
  return { canonical, candidate };
}

describe("OutcomeValidator", () => {
  it("returns bounded, deterministic change evidence", async () => {
    const { canonical, candidate } = await makeWorkspaces();
    for (let index = 0; index < 205; index += 1) {
      await writeFile(path.join(candidate, `file-${String(index).padStart(3, "0")}.txt`), "x");
    }
    const contract = createDefaultOutcomeContract();
    contract.maxChangedFiles = 500;
    const validator = new OutcomeValidator(
      new FixtureExecutor(() => passingResult()),
    );

    const result = await validator.validate(canonical, candidate, contract, "run-bounds");

    expect(result.changes).toMatchObject({
      totalChangedFiles: 205,
      totalAddedBytes: 205,
      truncated: true,
    });
    expect(result.changes.files).toHaveLength(200);
    expect(result.changes.files[0]?.path).toBe("file-000.txt");
    expect(result.validations.map((validation) => validation.name)).toEqual([
      "path-safety",
      "protected-paths",
      "required-paths",
      "change-limits",
      "secret-patterns",
      "assurance-catalog-rule:private-key-block:v1",
    ]);
    expect(
      result.validations
        .filter((validation) => validation.required)
        .every((validation) => validation.status === "passed"),
    ).toBe(true);
    expect(result.validations.at(-1)).toMatchObject({
      status: "error",
      required: false,
      summary: "Trusted catalog detector lacks complete bounded file evidence",
    });
  });

  it("counts the complete candidate payload for same-size file replacements", async () => {
    const { canonical, candidate } = await makeWorkspaces();
    await writeFile(path.join(candidate, "README.md"), "replaced\n");
    const contract = createDefaultOutcomeContract();
    contract.protectedPaths = [];
    const validator = new OutcomeValidator(
      new FixtureExecutor(() => passingResult()),
    );

    const result = await validator.validate(canonical, candidate, contract, "run-payload");

    expect(result.changes).toMatchObject({
      totalChangedFiles: 1,
      totalAddedBytes: Buffer.byteLength("replaced\n"),
      files: [
        {
          path: "README.md",
          kind: "modified",
          addedBytes: Buffer.byteLength("replaced\n"),
        },
      ],
    });
  });

  it("reports every decisive structural failure without storing a matched secret", async () => {
    const { canonical, candidate } = await makeWorkspaces();
    await rm(path.join(candidate, "README.md"));
    await writeFile(path.join(candidate, "AGENTS.md"), "changed\n");
    const secret = "ARK_API_KEY=super-secret-value-12345";
    await writeFile(path.join(candidate, "leak.txt"), secret + "\n");
    await symlink("/etc/passwd", path.join(candidate, "escape-link"));
    const contract = createDefaultOutcomeContract();
    contract.maxChangedFiles = 2;
    const validator = new OutcomeValidator(
      new FixtureExecutor(() => passingResult()),
    );

    const result = await validator.validate(canonical, candidate, contract, "run-failures");
    const failures = new Map(
      result.validations.map((validation) => [validation.name, validation]),
    );

    expect(failures.get("path-safety")?.status).toBe("failed");
    expect(failures.get("protected-paths")?.status).toBe("failed");
    expect(failures.get("required-paths")?.status).toBe("failed");
    expect(failures.get("change-limits")?.status).toBe("failed");
    expect(failures.get("secret-patterns")).toMatchObject({
      status: "failed",
      summary: "Secret-pattern findings: leak.txt matched ark-api-key-assignment",
    });
    expect(JSON.stringify(result)).not.toContain("super-secret-value-12345");
  });

  it("records a bounded optional trusted-catalog secret observation", async () => {
    const { canonical, candidate } = await makeWorkspaces();
    await writeFile(
      path.join(candidate, "fixture.pem"),
      "-----BEGIN PRIVATE KEY-----\nnot-retained\n-----END PRIVATE KEY-----\n",
    );
    const validator = new OutcomeValidator(
      new FixtureExecutor(() => passingResult()),
    );

    const result = await validator.validate(
      canonical,
      candidate,
      createDefaultOutcomeContract(),
      "run-observation",
    );
    const observation = result.validations.find(
      (validation) =>
        validation.name === "assurance-catalog-rule:private-key-block:v1",
    );

    expect(observation).toEqual(
      expect.objectContaining({
        status: "failed",
        required: false,
        summary: "Trusted catalog detector matched in 1 changed file(s)",
        output: null,
      }),
    );
    expect(JSON.stringify(observation)).not.toContain("not-retained");
  });

  it("reports unknown catalog evidence after the aggregate scan budget", async () => {
    const { canonical, candidate } = await makeWorkspaces();
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        writeFile(
          path.join(candidate, "a-" + String(index).padStart(3, "0") + ".txt"),
          "bounded\n",
        ),
      ),
    );
    await writeFile(
      path.join(candidate, "z-over-budget.pem"),
      "-----BEGIN PRIVATE KEY-----\nnot-retained\n",
    );
    const validator = new OutcomeValidator(
      new FixtureExecutor(() => passingResult()),
    );

    const result = await validator.validate(
      canonical,
      candidate,
      createDefaultOutcomeContract(),
      "run-observation-budget",
    );
    expect(
      result.validations.find(
        (validation) =>
          validation.name === "assurance-catalog-rule:private-key-block:v1",
      ),
    ).toMatchObject({
      status: "error",
      required: false,
      summary: "Trusted catalog detector lacks complete bounded file evidence",
      output: null,
    });
    expect(JSON.stringify(result)).not.toContain("not-retained");
  });

  it("bounds and redacts command evidence while preserving required severity", async () => {
    const { canonical, candidate } = await makeWorkspaces();
    const contract = createDefaultOutcomeContract();
    contract.validationCommands = [
      { name: "required-fail", command: "test", required: true, timeoutMs: 1_000 },
      { name: "optional-fail", command: "lint", required: false, timeoutMs: 1_000 },
      { name: "timeout", command: "slow", required: true, timeoutMs: 1_000 },
      { name: "overflow", command: "noisy", required: true, timeoutMs: 1_000 },
    ];
    const validator = new OutcomeValidator(
      new FixtureExecutor((name) => {
        if (name === "timeout") {
          return { ...passingResult(), exitCode: 1, timedOut: true };
        }
        if (name === "overflow") {
          return {
            ...passingResult("🙂".repeat(20_000)),
            exitCode: 1,
            outputExceeded: true,
          };
        }
        return {
          ...passingResult(
            "ARK_API_KEY=visible-key-12345\nBearer abcdefghijklmnop\n",
          ),
          exitCode: 1,
        };
      }),
    );

    const result = await validator.validate(canonical, candidate, contract, "run-commands");
    const commands = result.validations.filter((validation) =>
      validation.name.startsWith("command:"),
    );

    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "command:required-fail",
          status: "failed",
          required: true,
        }),
        expect.objectContaining({
          name: "command:optional-fail",
          status: "failed",
          required: false,
        }),
        expect.objectContaining({
          name: "command:timeout",
          status: "error",
          summary: "Validation command timed out",
        }),
        expect.objectContaining({
          name: "command:overflow",
          status: "error",
          summary: "Validation command exceeded the output limit",
        }),
      ]),
    );
    expect(
      Buffer.byteLength(
        commands.find((item) => item.name === "command:overflow")?.output ?? "",
      ),
    ).toBeLessThanOrEqual(16_384);
    expect(commands.find((item) => item.name === "command:overflow")?.output)
      .not.toContain("�");
    expect(JSON.stringify(commands)).not.toContain("visible-key-12345");
    expect(JSON.stringify(commands)).not.toContain("abcdefghijklmnop");
    expect(JSON.stringify(commands)).toContain("[REDACTED:");
  });

  it("does not persist a container startup error detail", async () => {
    const { canonical, candidate } = await makeWorkspaces();
    const contract = createDefaultOutcomeContract();
    contract.validationCommands = [
      { name: "test", command: "test", required: true, timeoutMs: 1_000 },
    ];
    const validator = new OutcomeValidator(
      new FixtureExecutor(() => {
        throw new Error("host path /private and ARK_API_KEY=do-not-store");
      }),
    );

    const result = await validator.validate(canonical, candidate, contract, "run-error");
    const evidence = result.validations.at(-1);

    expect(evidence).toMatchObject({
      name: "command:test",
      status: "error",
      summary: "Validation command could not start in its container",
    });
    expect(JSON.stringify(evidence)).not.toContain("do-not-store");
    expect(JSON.stringify(evidence)).not.toContain("/private");
  });

  it("runs each command on a disposable copy that cannot change Promotion input", async () => {
    const { canonical, candidate } = await makeWorkspaces();
    const contract = createDefaultOutcomeContract();
    contract.validationCommands = [
      { name: "build", command: "npm run build", required: true, timeoutMs: 30_000 },
    ];
    let validationWorkspacePath = "";
    const validator = new OutcomeValidator(
      new FixtureExecutor(async (_name, workspacePath) => {
        validationWorkspacePath = workspacePath;
        await writeFile(path.join(workspacePath, "build-artifact.txt"), "generated\n");
        return passingResult();
      }),
    );

    const result = await validator.validate(canonical, candidate, contract, "run-copy");

    expect(result.validations.at(-1)?.status).toBe("passed");
    expect(validationWorkspacePath).not.toBe(candidate);
    await expect(access(path.join(candidate, "build-artifact.txt"))).rejects.toThrow();
    await expect(access(validationWorkspacePath)).rejects.toThrow();
  });
});
