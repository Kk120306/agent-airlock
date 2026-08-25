import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { Agent, CanonicalStateReference } from "./types.js";

interface CanonicalManifest extends CanonicalStateReference {
  schemaVersion: 1;
  agentId: string;
  createdAt: string;
  sourceRunId: string | null;
}

interface CandidateManifest {
  schemaVersion: 1;
  agentId: string;
  runId: string;
  candidateStateId: string;
  canonicalStateIdBefore: string;
  canonicalContentHashBefore: string;
  createdAt: string;
}

export interface CandidateStateReference {
  candidateStateId: string;
  workspacePath: string;
  canonicalStateIdBefore: string;
  canonicalContentHashBefore: string;
}

const fileExists = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

const now = () => new Date().toISOString();

export class WorkspaceManager {
  constructor(private readonly root: string) {}

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await Promise.all([
      mkdir(path.join(this.root, ".candidates"), { recursive: true }),
      mkdir(path.join(this.root, ".deleted"), { recursive: true }),
      mkdir(path.join(this.root, ".migrations"), { recursive: true }),
      mkdir(path.join(this.root, ".quarantine"), { recursive: true }),
    ]);
  }

  async create(agent: Agent): Promise<CanonicalStateReference> {
    const stateId = randomUUID();
    const workspacePath = this.versionWorkspacePath(agent.id, stateId);
    await mkdir(workspacePath, { recursive: true });
    await this.writeInstructionsAt(workspacePath, agent);
    await writeFile(
      path.join(workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(workspacePath, "README.md"),
      [
        "# " + agent.name + " workspace",
        "",
        "Files created or edited by the Agent live here.",
        "The platform-generated AGENTS.md contains the current Agent instructions.",
        "",
      ].join("\n"),
      "utf8",
    );
    return this.publishInitialState(agent.id, stateId, workspacePath, null);
  }

  async ensureCanonical(agent: Agent): Promise<CanonicalStateReference> {
    const manifestPath = this.canonicalManifestPath(agent.id);
    if (await fileExists(manifestPath)) {
      return this.readCanonical(agent.id);
    }

    const legacyPath = agent.workspacePath;
    if (!legacyPath || !(await fileExists(legacyPath))) {
      throw new Error("Canonical workspace is missing for Agent " + agent.id);
    }

    const migrationPath = path.join(
      this.root,
      ".migrations",
      agent.id + "-" + randomUUID(),
    );
    const agentRoot = this.agentRoot(agent.id);
    const legacyIsAgentRoot = path.resolve(legacyPath) === path.resolve(agentRoot);
    if (legacyIsAgentRoot) {
      await rename(legacyPath, migrationPath);
    } else {
      await cp(legacyPath, migrationPath, {
        recursive: true,
        preserveTimestamps: true,
      });
    }

    const stateId = randomUUID();
    const workspacePath = this.versionWorkspacePath(agent.id, stateId);
    await mkdir(path.dirname(workspacePath), { recursive: true });
    await rename(migrationPath, workspacePath);
    return this.publishInitialState(agent.id, stateId, workspacePath, null);
  }

  async readCanonical(agentId: string): Promise<CanonicalStateReference> {
    const raw = await readFile(this.canonicalManifestPath(agentId), "utf8");
    const manifest = JSON.parse(raw) as CanonicalManifest;
    if (
      manifest.schemaVersion !== 1 ||
      manifest.agentId !== agentId ||
      typeof manifest.stateId !== "string" ||
      typeof manifest.workspacePath !== "string" ||
      typeof manifest.contentHash !== "string"
    ) {
      throw new Error("Invalid canonical manifest for Agent " + agentId);
    }
    const expectedWorkspace = this.versionWorkspacePath(agentId, manifest.stateId);
    if (path.resolve(manifest.workspacePath) !== path.resolve(expectedWorkspace)) {
      throw new Error("Canonical manifest contains an unexpected workspace path");
    }
    await access(expectedWorkspace);
    const actualContentHash = await this.contentHash(expectedWorkspace);
    if (actualContentHash !== manifest.contentHash) {
      throw new Error("Canonical State content does not match its immutable manifest");
    }
    return {
      stateId: manifest.stateId,
      workspacePath: expectedWorkspace,
      contentHash: manifest.contentHash,
    };
  }

  async prepareCandidate(
    agentId: string,
    runId: string,
  ): Promise<CandidateStateReference> {
    const canonical = await this.readCanonical(agentId);
    const root = this.candidateRoot(runId);
    if (await fileExists(root)) {
      throw new Error("Candidate State already exists for Run " + runId);
    }
    const candidateStateId = randomUUID();
    const workspacePath = path.join(root, "workspace");
    await mkdir(root, { recursive: false });
    try {
      await cp(canonical.workspacePath, workspacePath, {
        recursive: true,
        preserveTimestamps: true,
      });
      const manifest: CandidateManifest = {
        schemaVersion: 1,
        agentId,
        runId,
        candidateStateId,
        canonicalStateIdBefore: canonical.stateId,
        canonicalContentHashBefore: canonical.contentHash,
        createdAt: now(),
      };
      await this.writeJson(path.join(root, "candidate.json"), manifest);
      return {
        candidateStateId,
        workspacePath,
        canonicalStateIdBefore: canonical.stateId,
        canonicalContentHashBefore: canonical.contentHash,
      };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async promoteCandidate(
    agentId: string,
    runId: string,
  ): Promise<CanonicalStateReference> {
    const candidate = await this.readCandidate(runId);
    if (candidate.agentId !== agentId) {
      throw new Error("Candidate State belongs to a different Agent");
    }
    const current = await this.readCanonical(agentId);
    if (
      current.stateId !== candidate.canonicalStateIdBefore ||
      current.contentHash !== candidate.canonicalContentHashBefore
    ) {
      throw new Error("Canonical State changed while the Run Transaction was active");
    }

    const candidateRoot = this.candidateRoot(runId);
    const candidateWorkspace = path.join(candidateRoot, "workspace");
    const destination = this.versionWorkspacePath(agentId, candidate.candidateStateId);
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(candidateWorkspace, destination);
    const contentHash = await this.contentHash(destination);
    const manifest: CanonicalManifest = {
      schemaVersion: 1,
      agentId,
      stateId: candidate.candidateStateId,
      workspacePath: destination,
      contentHash,
      createdAt: now(),
      sourceRunId: runId,
    };
    await this.replaceCanonicalManifest(agentId, manifest);
    await rm(candidateRoot, { recursive: true, force: true }).catch(() => undefined);
    return {
      stateId: manifest.stateId,
      workspacePath: manifest.workspacePath,
      contentHash: manifest.contentHash,
    };
  }

  async quarantineCandidate(runId: string): Promise<string> {
    const source = this.candidateRoot(runId);
    await this.readCandidate(runId);
    const destination = this.quarantineRoot(runId);
    await rm(destination, { recursive: true, force: true });
    await rename(source, destination);
    return destination;
  }

  async cancelCandidate(runId: string): Promise<void> {
    await rm(this.candidateRoot(runId), { recursive: true, force: true });
  }

  async candidateHasPath(runId: string, relativePath: string): Promise<boolean> {
    const candidate = await this.readCandidate(runId);
    const workspacePath = path.join(this.candidateRoot(runId), "workspace");
    const target = path.resolve(workspacePath, relativePath);
    const relative = path.relative(workspacePath, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Candidate path escapes Candidate State");
    }
    if (candidate.runId !== runId) {
      throw new Error("Invalid Candidate State manifest");
    }
    return fileExists(target);
  }

  async updateInstructions(agent: Agent): Promise<CanonicalStateReference> {
    const runId = "config-" + randomUUID();
    const candidate = await this.prepareCandidate(agent.id, runId);
    try {
      await this.writeInstructionsAt(candidate.workspacePath, agent);
      return await this.promoteCandidate(agent.id, runId);
    } catch (error) {
      await this.cancelCandidate(runId);
      throw error;
    }
  }

  async archive(agent: Agent): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      ".deleted",
      agent.id + "-" + timestamp,
    );
    await rename(this.agentRoot(agent.id), destination);
    return destination;
  }

  async contentHash(workspacePath: string): Promise<string> {
    const hash = createHash("sha256");
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        const relative = path
          .relative(workspacePath, absolute)
          .split(path.sep)
          .join("/");
        const stats = await lstat(absolute);
        if (stats.isDirectory()) {
          hash.update("directory\0" + relative + "\0");
          await visit(absolute);
        } else if (stats.isSymbolicLink()) {
          hash.update(
            "symlink\0" + relative + "\0" + (await readlink(absolute)) + "\0",
          );
        } else if (stats.isFile()) {
          hash.update("file\0" + relative + "\0" + stats.size + "\0");
          for await (const chunk of createReadStream(absolute)) hash.update(chunk);
          hash.update("\0");
        }
      }
    };
    await visit(workspacePath);
    return "sha256:" + hash.digest("hex");
  }

  private async publishInitialState(
    agentId: string,
    stateId: string,
    workspacePath: string,
    sourceRunId: string | null,
  ): Promise<CanonicalStateReference> {
    const contentHash = await this.contentHash(workspacePath);
    const manifest: CanonicalManifest = {
      schemaVersion: 1,
      agentId,
      stateId,
      workspacePath,
      contentHash,
      createdAt: now(),
      sourceRunId,
    };
    await this.replaceCanonicalManifest(agentId, manifest);
    return { stateId, workspacePath, contentHash };
  }

  private async readCandidate(runId: string): Promise<CandidateManifest> {
    const raw = await readFile(
      path.join(this.candidateRoot(runId), "candidate.json"),
      "utf8",
    );
    const manifest = JSON.parse(raw) as CandidateManifest;
    if (
      manifest.schemaVersion !== 1 ||
      manifest.runId !== runId ||
      typeof manifest.agentId !== "string" ||
      typeof manifest.candidateStateId !== "string"
    ) {
      throw new Error("Invalid Candidate State manifest for Run " + runId);
    }
    return manifest;
  }

  private async replaceCanonicalManifest(
    agentId: string,
    manifest: CanonicalManifest,
  ): Promise<void> {
    const target = this.canonicalManifestPath(agentId);
    const temporary = target + "." + randomUUID() + ".tmp";
    await mkdir(path.dirname(target), { recursive: true });
    await this.writeJson(temporary, manifest);
    await rename(temporary, target);
  }

  private async writeInstructionsAt(
    workspacePath: string,
    agent: Agent,
  ): Promise<void> {
    const content = [
      "# Platform-managed Agent instructions",
      "",
      "You are the coding Agent named " + agent.name + ".",
      agent.description ? "Purpose: " + agent.description : "",
      "",
      "## Instructions",
      "",
      agent.instructions ||
        "Help the user complete coding tasks in this workspace. Explain material results concisely.",
      "",
      "## Workspace rules",
      "",
      "- Work only inside this workspace unless the user explicitly requests otherwise.",
      "- Preserve existing user files and avoid destructive operations.",
      "- Build and test changes when practical.",
      "- Never print environment variables or credentials.",
      "",
      "This file is regenerated when the Agent configuration is updated.",
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
    await writeFile(path.join(workspacePath, "AGENTS.md"), content, "utf8");
  }

  private async writeJson(target: string, value: unknown): Promise<void> {
    await writeFile(target, JSON.stringify(value, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  private agentRoot(agentId: string): string {
    return path.join(this.root, agentId);
  }

  private canonicalManifestPath(agentId: string): string {
    return path.join(this.agentRoot(agentId), "canonical.json");
  }

  private versionWorkspacePath(agentId: string, stateId: string): string {
    return path.join(this.agentRoot(agentId), "versions", stateId, "workspace");
  }

  private candidateRoot(runId: string): string {
    return path.join(this.root, ".candidates", runId);
  }

  private quarantineRoot(runId: string): string {
    return path.join(this.root, ".quarantine", runId);
  }
}
