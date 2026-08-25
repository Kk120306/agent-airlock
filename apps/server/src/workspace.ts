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
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { Agent, CanonicalStateReference } from "./types.js";

interface CanonicalManifestV1 {
  schemaVersion: 1;
  agentId: string;
  stateId: string;
  workspacePath: string;
  contentHash: string;
  createdAt: string;
  sourceRunId: string | null;
}

interface CanonicalManifestV2 extends CanonicalStateReference {
  schemaVersion: 2;
  agentId: string;
  createdAt: string;
  sourceRunId: string | null;
}

interface CandidateManifestV2 {
  schemaVersion: 2;
  agentId: string;
  runId: string;
  candidateStateId: string;
  canonicalStateIdBefore: string;
  canonicalContentHashBefore: string;
  canonicalWorkspaceHashBefore: string;
  canonicalSessionHashBefore: string;
  canonicalThreadIdBefore: string | null;
  candidateThreadId: string | null;
  createdAt: string;
}

export interface CandidateStateReference {
  candidateStateId: string;
  workspacePath: string;
  codexHomePath: string;
  canonicalStateIdBefore: string;
  canonicalContentHashBefore: string;
  canonicalWorkspaceHashBefore: string;
  canonicalSessionHashBefore: string;
  canonicalThreadIdBefore: string | null;
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
  constructor(
    private readonly root: string,
    private readonly codexTemplateHome?: string,
  ) {}

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
    const codexHomePath = this.versionCodexHomePath(agent.id, stateId);
    await Promise.all([
      mkdir(workspacePath, { recursive: true }),
      mkdir(codexHomePath, { recursive: true }),
    ]);
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
    await this.seedCodexHome(codexHomePath);
    return this.publishInitialState(
      agent.id,
      stateId,
      workspacePath,
      codexHomePath,
      null,
      null,
    );
  }

  async ensureCanonical(agent: Agent): Promise<CanonicalStateReference> {
    const manifestPath = this.canonicalManifestPath(agent.id);
    if (await fileExists(manifestPath)) {
      const raw = await readFile(manifestPath, "utf8");
      const manifest = JSON.parse(raw) as CanonicalManifestV1 | CanonicalManifestV2;
      if (manifest.schemaVersion === 1) {
        return this.migrateCanonicalManifest(agent, manifest);
      }
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
    const codexHomePath = this.versionCodexHomePath(agent.id, stateId);
    await mkdir(path.dirname(workspacePath), { recursive: true });
    await rename(migrationPath, workspacePath);
    await mkdir(codexHomePath, { recursive: true });
    await this.seedCodexHome(codexHomePath);
    const preservedThread = await this.copyLegacySession(
      agent.codexThreadId,
      codexHomePath,
    );
    return this.publishInitialState(
      agent.id,
      stateId,
      workspacePath,
      codexHomePath,
      preservedThread ? agent.codexThreadId : null,
      null,
    );
  }

  async readCanonical(agentId: string): Promise<CanonicalStateReference> {
    const raw = await readFile(this.canonicalManifestPath(agentId), "utf8");
    const manifest = JSON.parse(raw) as CanonicalManifestV2;
    if (
      manifest.schemaVersion !== 2 ||
      manifest.agentId !== agentId ||
      typeof manifest.stateId !== "string" ||
      typeof manifest.workspacePath !== "string" ||
      typeof manifest.codexHomePath !== "string" ||
      (manifest.codexThreadId !== null && typeof manifest.codexThreadId !== "string") ||
      typeof manifest.workspaceContentHash !== "string" ||
      typeof manifest.sessionContentHash !== "string" ||
      typeof manifest.contentHash !== "string"
    ) {
      throw new Error("Invalid canonical manifest for Agent " + agentId);
    }
    const expectedWorkspace = this.versionWorkspacePath(agentId, manifest.stateId);
    const expectedCodexHome = this.versionCodexHomePath(agentId, manifest.stateId);
    if (
      path.resolve(manifest.workspacePath) !== path.resolve(expectedWorkspace) ||
      path.resolve(manifest.codexHomePath) !== path.resolve(expectedCodexHome)
    ) {
      throw new Error("Canonical manifest contains an unexpected resource path");
    }
    await Promise.all([access(expectedWorkspace), access(expectedCodexHome)]);
    const actual = await this.buildStateReference(
      agentId,
      manifest.stateId,
      manifest.codexThreadId,
    );
    if (
      actual.workspaceContentHash !== manifest.workspaceContentHash ||
      actual.sessionContentHash !== manifest.sessionContentHash ||
      actual.contentHash !== manifest.contentHash
    ) {
      throw new Error("Canonical State content does not match its immutable manifest");
    }
    return actual;
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
    const codexHomePath = path.join(root, "codex-home");
    await mkdir(root, { recursive: false });
    try {
      await Promise.all([
        cp(canonical.workspacePath, workspacePath, {
          recursive: true,
          preserveTimestamps: true,
        }),
        cp(canonical.codexHomePath, codexHomePath, {
          recursive: true,
          preserveTimestamps: true,
        }),
      ]);
      await this.refreshCodexConfig(codexHomePath);
      const manifest: CandidateManifestV2 = {
        schemaVersion: 2,
        agentId,
        runId,
        candidateStateId,
        canonicalStateIdBefore: canonical.stateId,
        canonicalContentHashBefore: canonical.contentHash,
        canonicalWorkspaceHashBefore: canonical.workspaceContentHash,
        canonicalSessionHashBefore: canonical.sessionContentHash,
        canonicalThreadIdBefore: canonical.codexThreadId,
        candidateThreadId: canonical.codexThreadId,
        createdAt: now(),
      };
      await this.writeJson(path.join(root, "candidate.json"), manifest);
      return {
        candidateStateId,
        workspacePath,
        codexHomePath,
        canonicalStateIdBefore: canonical.stateId,
        canonicalContentHashBefore: canonical.contentHash,
        canonicalWorkspaceHashBefore: canonical.workspaceContentHash,
        canonicalSessionHashBefore: canonical.sessionContentHash,
        canonicalThreadIdBefore: canonical.codexThreadId,
      };
    } catch (error) {
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async recordCandidateThread(runId: string, threadId: string | null): Promise<void> {
    const manifest = await this.readCandidate(runId);
    if (threadId && !(await this.hasSessionArtifact(this.candidateCodexPath(runId), threadId))) {
      throw new Error(
        "Codex returned thread " + threadId + " without a Candidate session artifact",
      );
    }
    manifest.candidateThreadId = threadId;
    await this.writeJson(path.join(this.candidateRoot(runId), "candidate.json"), manifest);
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
      current.contentHash !== candidate.canonicalContentHashBefore ||
      current.workspaceContentHash !== candidate.canonicalWorkspaceHashBefore ||
      current.sessionContentHash !== candidate.canonicalSessionHashBefore ||
      current.codexThreadId !== candidate.canonicalThreadIdBefore
    ) {
      throw new Error("Canonical State changed while the Run Transaction was active");
    }

    await this.assertSessionTreeSafe(this.candidateCodexPath(runId));
    const candidateRoot = this.candidateRoot(runId);
    const destinationRoot = this.versionRoot(agentId, candidate.candidateStateId);
    await mkdir(path.dirname(destinationRoot), { recursive: true });
    await rename(candidateRoot, destinationRoot);
    try {
      const canonical = await this.buildStateReference(
        agentId,
        candidate.candidateStateId,
        candidate.candidateThreadId,
      );
      const manifest: CanonicalManifestV2 = {
        schemaVersion: 2,
        agentId,
        ...canonical,
        createdAt: now(),
        sourceRunId: runId,
      };
      await this.replaceCanonicalManifest(agentId, manifest);
      return canonical;
    } catch (error) {
      await rename(destinationRoot, candidateRoot).catch(() => undefined);
      throw error;
    }
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

  async candidateWorkspacePath(runId: string): Promise<string> {
    await this.readCandidate(runId);
    return this.resolveCandidatePath(runId, "workspace");
  }

  async candidateCodexHomePath(runId: string): Promise<string> {
    await this.readCandidate(runId);
    return this.resolveCandidatePath(runId, "codex-home");
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
    const destination = path.join(this.root, ".deleted", agent.id + "-" + timestamp);
    await rename(this.agentRoot(agent.id), destination);
    return destination;
  }

  async contentHash(rootPath: string): Promise<string> {
    const hash = createHash("sha256");
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(rootPath, absolute).split(path.sep).join("/");
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
        } else {
          throw new Error("Unsupported state entry: " + relative);
        }
      }
    };
    await visit(rootPath);
    return "sha256:" + hash.digest("hex");
  }

  private async migrateCanonicalManifest(
    agent: Agent,
    manifest: CanonicalManifestV1,
  ): Promise<CanonicalStateReference> {
    if (
      manifest.agentId !== agent.id ||
      typeof manifest.stateId !== "string" ||
      path.resolve(manifest.workspacePath) !==
        path.resolve(this.versionWorkspacePath(agent.id, manifest.stateId))
    ) {
      throw new Error("Invalid schema 1 canonical manifest for Agent " + agent.id);
    }
    const codexHomePath = this.versionCodexHomePath(agent.id, manifest.stateId);
    await mkdir(codexHomePath, { recursive: true });
    await this.seedCodexHome(codexHomePath);
    const preservedThread = await this.copyLegacySession(
      agent.codexThreadId,
      codexHomePath,
    );
    const canonical = await this.buildStateReference(
      agent.id,
      manifest.stateId,
      preservedThread ? agent.codexThreadId : null,
    );
    await this.replaceCanonicalManifest(agent.id, {
      schemaVersion: 2,
      agentId: agent.id,
      ...canonical,
      createdAt: manifest.createdAt,
      sourceRunId: manifest.sourceRunId,
    });
    return canonical;
  }

  private async publishInitialState(
    agentId: string,
    stateId: string,
    workspacePath: string,
    codexHomePath: string,
    codexThreadId: string | null,
    sourceRunId: string | null,
  ): Promise<CanonicalStateReference> {
    const canonical = await this.buildStateReference(agentId, stateId, codexThreadId);
    if (
      path.resolve(canonical.workspacePath) !== path.resolve(workspacePath) ||
      path.resolve(canonical.codexHomePath) !== path.resolve(codexHomePath)
    ) {
      throw new Error("Initial Canonical State paths do not match the version layout");
    }
    await this.replaceCanonicalManifest(agentId, {
      schemaVersion: 2,
      agentId,
      ...canonical,
      createdAt: now(),
      sourceRunId,
    });
    return canonical;
  }

  private async buildStateReference(
    agentId: string,
    stateId: string,
    codexThreadId: string | null,
  ): Promise<CanonicalStateReference> {
    const workspacePath = this.versionWorkspacePath(agentId, stateId);
    const codexHomePath = this.versionCodexHomePath(agentId, stateId);
    const [workspaceContentHash, sessionContentHash] = await Promise.all([
      this.contentHash(workspacePath),
      this.contentHash(codexHomePath),
    ]);
    const contentHash =
      "sha256:" +
      createHash("sha256")
        .update(
          JSON.stringify({ workspaceContentHash, sessionContentHash, codexThreadId }),
        )
        .digest("hex");
    return {
      stateId,
      workspacePath,
      codexHomePath,
      codexThreadId,
      workspaceContentHash,
      sessionContentHash,
      contentHash,
    };
  }

  private async readCandidate(runId: string): Promise<CandidateManifestV2> {
    const raw = await readFile(
      path.join(this.candidateRoot(runId), "candidate.json"),
      "utf8",
    );
    const manifest = JSON.parse(raw) as CandidateManifestV2;
    if (
      manifest.schemaVersion !== 2 ||
      manifest.runId !== runId ||
      typeof manifest.agentId !== "string" ||
      typeof manifest.candidateStateId !== "string" ||
      typeof manifest.canonicalContentHashBefore !== "string" ||
      typeof manifest.canonicalWorkspaceHashBefore !== "string" ||
      typeof manifest.canonicalSessionHashBefore !== "string" ||
      (manifest.canonicalThreadIdBefore !== null &&
        typeof manifest.canonicalThreadIdBefore !== "string") ||
      (manifest.candidateThreadId !== null &&
        typeof manifest.candidateThreadId !== "string")
    ) {
      throw new Error("Invalid Candidate State manifest for Run " + runId);
    }
    return manifest;
  }

  private async replaceCanonicalManifest(
    agentId: string,
    manifest: CanonicalManifestV2,
  ): Promise<void> {
    const target = this.canonicalManifestPath(agentId);
    const temporary = target + "." + randomUUID() + ".tmp";
    await mkdir(path.dirname(target), { recursive: true });
    await this.writeJson(temporary, manifest);
    await rename(temporary, target);
  }

  private async seedCodexHome(codexHomePath: string): Promise<void> {
    await mkdir(codexHomePath, { recursive: true });
    await this.refreshCodexConfig(codexHomePath);
  }

  private async refreshCodexConfig(codexHomePath: string): Promise<void> {
    if (!this.codexTemplateHome) return;
    const source = path.join(this.codexTemplateHome, "config.toml");
    if (!(await fileExists(source))) return;
    const destination = path.join(codexHomePath, "config.toml");
    await rm(destination, { force: true });
    await cp(source, destination, { preserveTimestamps: true });
  }

  private async copyLegacySession(
    threadId: string | null,
    destinationHome: string,
  ): Promise<boolean> {
    if (!threadId || !this.codexTemplateHome) return false;
    const sessionsRoot = path.join(this.codexTemplateHome, "sessions");
    if (!(await fileExists(sessionsRoot))) return false;
    const source = await this.findSessionArtifact(sessionsRoot, threadId);
    if (!source) return false;
    const relative = path.relative(this.codexTemplateHome, source);
    const destination = path.join(destinationHome, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { preserveTimestamps: true });

    const shellSnapshot = path.join(
      this.codexTemplateHome,
      "shell_snapshots",
      threadId + ".sh",
    );
    if (await fileExists(shellSnapshot)) {
      const shellDestination = path.join(
        destinationHome,
        "shell_snapshots",
        threadId + ".sh",
      );
      await mkdir(path.dirname(shellDestination), { recursive: true });
      await cp(shellSnapshot, shellDestination, { preserveTimestamps: true });
    }
    return true;
  }

  private async hasSessionArtifact(
    codexHomePath: string,
    threadId: string,
  ): Promise<boolean> {
    const sessionsRoot = path.join(codexHomePath, "sessions");
    if (!(await fileExists(sessionsRoot))) return false;
    return (await this.findSessionArtifact(sessionsRoot, threadId)) !== null;
  }

  private async findSessionArtifact(
    directory: string,
    threadId: string,
  ): Promise<string | null> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const nested = await this.findSessionArtifact(absolute, threadId);
        if (nested) return nested;
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".jsonl") &&
        entry.name.includes(threadId)
      ) {
        return absolute;
      }
    }
    return null;
  }

  private async assertSessionTreeSafe(codexHomePath: string): Promise<void> {
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        const stats = await lstat(absolute);
        if (stats.isSymbolicLink()) {
          throw new Error(
            "Candidate Codex session contains a symbolic link: " +
              path.relative(codexHomePath, absolute).split(path.sep).join("/"),
          );
        }
        if (stats.isDirectory()) await visit(absolute);
      }
    };
    await visit(codexHomePath);
  }

  private async resolveCandidatePath(
    runId: string,
    resource: "workspace" | "codex-home",
  ): Promise<string> {
    const candidatesRoot = await realpath(path.join(this.root, ".candidates"));
    const resourcePath = await realpath(path.join(this.candidateRoot(runId), resource));
    const relative = path.relative(candidatesRoot, resourcePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Candidate resource escapes the Candidate State root");
    }
    return resourcePath;
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

  private versionRoot(agentId: string, stateId: string): string {
    return path.join(this.agentRoot(agentId), "versions", stateId);
  }

  private versionWorkspacePath(agentId: string, stateId: string): string {
    return path.join(this.versionRoot(agentId, stateId), "workspace");
  }

  private versionCodexHomePath(agentId: string, stateId: string): string {
    return path.join(this.versionRoot(agentId, stateId), "codex-home");
  }

  private candidateRoot(runId: string): string {
    return path.join(this.root, ".candidates", runId);
  }

  private candidateCodexPath(runId: string): string {
    return path.join(this.candidateRoot(runId), "codex-home");
  }

  private quarantineRoot(runId: string): string {
    return path.join(this.root, ".quarantine", runId);
  }
}
