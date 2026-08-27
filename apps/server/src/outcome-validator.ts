import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { ASSURANCE_SECRET_CATALOG } from "./assurance.js";
import { SQLITE_RELATIVE_PATH } from "./sqlite-resource.js";
import type {
  OutcomeContract,
  ValidationEvidence,
  WorkspaceChange,
  WorkspaceChangeSummary,
} from "./types.js";
import type { ValidationCommandExecutor } from "./validation-command-runner.js";

const MAX_INVENTORY_ENTRIES = 10_000;
const MAX_EVIDENCE_CHANGES = 200;
const MAX_SECRET_SCAN_FILE_BYTES = 1_048_576;
const MAX_ASSURANCE_CATALOG_SCAN_FILES = 100;
const MAX_ASSURANCE_CATALOG_SCAN_BYTES = 4_194_304;
const MAX_PERSISTED_COMMAND_OUTPUT_BYTES = 16_384;

interface InventoryEntry {
  path: string;
  kind: "file" | "directory" | "symlink";
  size: number;
  hash: string | null;
  linkTarget: string | null;
}

interface DescribedChanges {
  summary: WorkspaceChangeSummary;
  all: WorkspaceChange[];
}

export interface OutcomeValidationResult {
  changes: WorkspaceChangeSummary;
  validations: ValidationEvidence[];
}

const requiredEvidence = (
  name: string,
  status: ValidationEvidence["status"],
  summary: string,
  startedAt: number,
): ValidationEvidence => ({
  name,
  status,
  required: true,
  summary,
  durationMs: Date.now() - startedAt,
  output: null,
});

export class OutcomeValidator {
  constructor(private readonly commandExecutor: ValidationCommandExecutor) {}

  async validate(
    canonicalWorkspacePath: string,
    candidateWorkspacePath: string,
    contract: OutcomeContract,
    runId: string,
  ): Promise<OutcomeValidationResult> {
    const inventoryStarted = Date.now();
    let canonicalInventory: Map<string, InventoryEntry>;
    let candidateInventory: Map<string, InventoryEntry>;
    try {
      [canonicalInventory, candidateInventory] = await Promise.all([
        this.inventory(canonicalWorkspacePath),
        this.inventory(candidateWorkspacePath),
      ]);
    } catch (error) {
      void error;
      return {
        changes: {
          files: [],
          totalChangedFiles: 0,
          totalAddedBytes: 0,
          truncated: false,
        },
        validations: [
          requiredEvidence(
            "candidate-inventory",
            "error",
            "Candidate State could not be inventoried safely",
            inventoryStarted,
          ),
        ],
      };
    }

    const describedChanges = this.describeChanges(
      canonicalInventory,
      candidateInventory,
    );
    const changes = describedChanges.summary;
    const validations: ValidationEvidence[] = [];

    const pathSafetyStarted = Date.now();
    const unsafeLinks = [...candidateInventory.values()].filter(
      (entry) => entry.kind === "symlink",
    );
    validations.push(
      requiredEvidence(
        "path-safety",
        unsafeLinks.length === 0 ? "passed" : "failed",
        unsafeLinks.length === 0
          ? "Candidate State contains no symbolic links"
          : "Candidate State contains symbolic links: " +
              unsafeLinks
                .slice(0, 5)
                .map((entry) => entry.path)
                .join(", "),
        pathSafetyStarted,
      ),
    );

    const protectedStarted = Date.now();
    const protectedChanges = describedChanges.all.filter((change) =>
      contract.protectedPaths.some((pattern) => matchesPattern(change.path, pattern)),
    );
    validations.push(
      requiredEvidence(
        "protected-paths",
        protectedChanges.length === 0 ? "passed" : "failed",
        protectedChanges.length === 0
          ? "No protected path changed"
          : "Protected paths changed: " +
              protectedChanges
                .slice(0, 5)
                .map((change) => change.path)
                .join(", "),
        protectedStarted,
      ),
    );

    const requiredStarted = Date.now();
    const candidatePaths = [...candidateInventory.keys()];
    const missingPatterns = contract.requiredPaths.filter(
      (pattern) => !candidatePaths.some((candidatePath) => matchesPattern(candidatePath, pattern)),
    );
    validations.push(
      requiredEvidence(
        "required-paths",
        missingPatterns.length === 0 ? "passed" : "failed",
        missingPatterns.length === 0
          ? "Every required path pattern is present"
          : "Required path patterns are missing: " + missingPatterns.join(", "),
        requiredStarted,
      ),
    );

    const limitsStarted = Date.now();
    const limitsPassed =
      changes.totalChangedFiles <= contract.maxChangedFiles &&
      changes.totalAddedBytes <= contract.maxAddedBytes;
    validations.push(
      requiredEvidence(
        "change-limits",
        limitsPassed ? "passed" : "failed",
        limitsPassed
          ? `${changes.totalChangedFiles} changed files and ${changes.totalAddedBytes} changed payload bytes are within limits`
          : `${changes.totalChangedFiles} changed files or ${changes.totalAddedBytes} changed payload bytes exceed the Outcome Contract`,
        limitsStarted,
      ),
    );

    try {
      validations.push(
        await this.validateSecrets(
          candidateWorkspacePath,
          candidateInventory,
          describedChanges.all,
          contract,
        ),
      );
    } catch (error) {
      void error;
      validations.push(
        requiredEvidence(
          "secret-patterns",
          "error",
          "Changed files could not be scanned safely for secret patterns",
          Date.now(),
        ),
      );
    }

    try {
      validations.push(
        ...(await this.observeAssuranceCatalogSecrets(
          candidateWorkspacePath,
          candidateInventory,
          describedChanges.all,
        )),
      );
    } catch {
      validations.push(
        ...ASSURANCE_SECRET_CATALOG.rules.map((rule) => ({
          name: "assurance-catalog-rule:" + rule.name + ":v1",
          status: "error" as const,
          required: false,
          summary: "Trusted catalog secret observation could not complete safely",
          durationMs: 0,
          output: null,
        })),
      );
    }

    for (const command of contract.validationCommands) {
      const commandStarted = Date.now();
      let validationRoot: string | null = null;
      try {
        validationRoot = await mkdtemp(
          path.join(path.dirname(candidateWorkspacePath), ".validation-"),
        );
        const validationWorkspacePath = path.join(validationRoot, "workspace");
        await cp(candidateWorkspacePath, validationWorkspacePath, {
          recursive: true,
          preserveTimestamps: true,
        });
        const result = await this.commandExecutor.execute(
          validationWorkspacePath,
          command,
          runId,
        );
        const status: ValidationEvidence["status"] =
          result.timedOut || result.outputExceeded
            ? "error"
            : result.exitCode === 0
              ? "passed"
              : "failed";
        const summary = result.timedOut
          ? "Validation command timed out"
          : result.outputExceeded
            ? "Validation command exceeded the output limit"
            : result.exitCode === 0
              ? "Validation command exited successfully"
              : "Validation command exited with code " + result.exitCode;
        validations.push({
          name: "command:" + command.name,
          status,
          required: command.required,
          summary,
          durationMs: Math.max(result.durationMs, Date.now() - commandStarted),
          output:
            truncateUtf8(
              redactEvidence(result.output, contract),
              MAX_PERSISTED_COMMAND_OUTPUT_BYTES,
            ) || null,
        });
      } catch (error) {
        void error;
        validations.push({
          name: "command:" + command.name,
          status: "error",
          required: command.required,
          summary: "Validation command could not start in its container",
          durationMs: Date.now() - commandStarted,
          output: null,
        });
      } finally {
        if (validationRoot) {
          await rm(validationRoot, { recursive: true, force: true });
        }
      }
    }

    return { changes, validations };
  }

  private async validateSecrets(
    candidateWorkspacePath: string,
    candidateInventory: Map<string, InventoryEntry>,
    changes: WorkspaceChange[],
    contract: OutcomeContract,
  ): Promise<ValidationEvidence> {
    const startedAt = Date.now();
    const findings: string[] = [];
    const changedFilePaths = changes
      .filter((change) => change.kind !== "deleted")
      .map((change) => change.path);
    for (const relativePath of changedFilePaths) {
      if (relativePath === SQLITE_RELATIVE_PATH) continue;
      const entry = candidateInventory.get(relativePath);
      if (!entry || entry.kind !== "file") continue;
      if (entry.size > MAX_SECRET_SCAN_FILE_BYTES) {
        findings.push(relativePath + " exceeds the safe secret-scan size");
        continue;
      }
      const content = await readFile(path.join(candidateWorkspacePath, relativePath), "utf8");
      for (const secretPattern of contract.secretPatterns) {
        const expression = new RegExp(secretPattern.pattern, "gi");
        if (expression.test(content)) {
          findings.push(relativePath + " matched " + secretPattern.name);
        }
      }
    }
    return requiredEvidence(
      "secret-patterns",
      findings.length === 0 ? "passed" : "failed",
      findings.length === 0
        ? "Changed files contain no configured secret pattern"
        : "Secret-pattern findings: " + findings.slice(0, 10).join(", "),
      startedAt,
    );
  }

  private async observeAssuranceCatalogSecrets(
    candidateWorkspacePath: string,
    candidateInventory: Map<string, InventoryEntry>,
    changes: WorkspaceChange[],
  ): Promise<ValidationEvidence[]> {
    const startedAt = Date.now();
    const matches = new Map(
      ASSURANCE_SECRET_CATALOG.rules.map((rule) => [rule.name, 0]),
    );
    let incomplete = false;
    let scannedFiles = 0;
    let scannedBytes = 0;
    for (const change of changes) {
      if (change.kind === "deleted" || change.path === SQLITE_RELATIVE_PATH) continue;
      const entry = candidateInventory.get(change.path);
      if (!entry || entry.kind !== "file") continue;
      if (entry.size > MAX_SECRET_SCAN_FILE_BYTES) {
        incomplete = true;
        continue;
      }
      if (
        scannedFiles >= MAX_ASSURANCE_CATALOG_SCAN_FILES ||
        scannedBytes + entry.size > MAX_ASSURANCE_CATALOG_SCAN_BYTES
      ) {
        incomplete = true;
        continue;
      }
      const content = await readFile(
        path.join(candidateWorkspacePath, change.path),
        "utf8",
      );
      scannedFiles += 1;
      scannedBytes += entry.size;
      for (const rule of ASSURANCE_SECRET_CATALOG.rules) {
        if (new RegExp(rule.pattern, "gi").test(content)) {
          matches.set(rule.name, (matches.get(rule.name) ?? 0) + 1);
        }
      }
    }
    return ASSURANCE_SECRET_CATALOG.rules.map((rule) => {
      const matchCount = matches.get(rule.name) ?? 0;
      return {
        name: "assurance-catalog-rule:" + rule.name + ":v1",
        status: matchCount > 0 ? "failed" : incomplete ? "error" : "passed",
        required: false,
        summary:
          matchCount > 0
            ? "Trusted catalog detector matched in " + matchCount + " changed file(s)"
            : incomplete
              ? "Trusted catalog detector lacks complete bounded file evidence"
              : "Trusted catalog detector found no match in changed files",
        durationMs: Date.now() - startedAt,
        output: null,
      };
    });
  }

  private async inventory(workspacePath: string): Promise<Map<string, InventoryEntry>> {
    const inventory = new Map<string, InventoryEntry>();
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (inventory.size >= MAX_INVENTORY_ENTRIES) {
          throw new Error(
            "Workspace inventory exceeds " + MAX_INVENTORY_ENTRIES + " entries",
          );
        }
        const absolute = path.join(directory, entry.name);
        const relative = path
          .relative(workspacePath, absolute)
          .split(path.sep)
          .join("/");
        const stats = await lstat(absolute);
        if (stats.isDirectory()) {
          inventory.set(relative, {
            path: relative,
            kind: "directory",
            size: 0,
            hash: null,
            linkTarget: null,
          });
          await visit(absolute);
        } else if (stats.isSymbolicLink()) {
          inventory.set(relative, {
            path: relative,
            kind: "symlink",
            size: stats.size,
            hash: null,
            linkTarget: await readlink(absolute),
          });
        } else if (stats.isFile()) {
          inventory.set(relative, {
            path: relative,
            kind: "file",
            size: stats.size,
            hash: await hashFile(absolute),
            linkTarget: null,
          });
        }
      }
    };
    await visit(workspacePath);
    return inventory;
  }

  private describeChanges(
    canonical: Map<string, InventoryEntry>,
    candidate: Map<string, InventoryEntry>,
  ): DescribedChanges {
    const paths = new Set([...canonical.keys(), ...candidate.keys()]);
    const changes: WorkspaceChange[] = [];
    let totalAddedBytes = 0;
    for (const relativePath of [...paths].sort()) {
      const before = canonical.get(relativePath);
      const after = candidate.get(relativePath);
      if (before?.kind === "directory" && after?.kind === "directory") continue;
      if (!before && after) {
        const addedBytes = after.kind === "file" ? after.size : 0;
        changes.push({ path: relativePath, kind: "added", addedBytes });
        totalAddedBytes += addedBytes;
      } else if (before && !after) {
        changes.push({ path: relativePath, kind: "deleted", addedBytes: 0 });
      } else if (
        before &&
        after &&
        (before.kind !== after.kind ||
          before.hash !== after.hash ||
          before.linkTarget !== after.linkTarget)
      ) {
        const addedBytes = after.kind === "file" ? after.size : 0;
        changes.push({ path: relativePath, kind: "modified", addedBytes });
        totalAddedBytes += addedBytes;
      }
    }
    return {
      all: changes,
      summary: {
        files: changes.slice(0, MAX_EVIDENCE_CHANGES),
        totalChangedFiles: changes.length,
        totalAddedBytes,
        truncated: changes.length > MAX_EVIDENCE_CHANGES,
      },
    };
  }
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function matchesPattern(relativePath: string, pattern: string): boolean {
  return globToRegExp(pattern).test(relativePath);
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern.charAt(index);
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(source + "$");
}

function redactEvidence(output: string, contract: OutcomeContract): string {
  let redacted = output;
  const patterns = [
    ...contract.secretPatterns,
    {
      name: "mandatory-ark-key",
      pattern: "ARK_API_KEY\\s*[:=]\\s*['\\\"]?[^\\s'\\\"]{4,}",
    },
    {
      name: "mandatory-bearer-token",
      pattern: "Bearer\\s+[A-Za-z0-9._~+/-]{8,}=*",
    },
  ];
  for (const pattern of patterns) {
    redacted = redacted.replace(
      new RegExp(pattern.pattern, "gi"),
      "[REDACTED:" + pattern.name + "]",
    );
  }
  return redacted.trim();
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  const decoder = new StringDecoder("utf8");
  return decoder.write(bytes.subarray(0, maxBytes));
}
