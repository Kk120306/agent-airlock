import { Buffer } from "node:buffer";
import { canonicalize, parseCanonicalJson, utf8Bytes } from "./canonical.js";
import { sha256Digest } from "./crypto.js";
import type { ReceiptDigest } from "./types.js";
import { isDigest } from "./validation.js";

export const MAXIMUM_WORKSPACE_CHANGE_SET_BYTES = 8_388_608;
export const MAXIMUM_WORKSPACE_CHANGE_OPERATIONS = 4_096;
export const MAXIMUM_WORKSPACE_FILE_BYTES = 5_242_880;
export const MAXIMUM_WORKSPACE_CONTENT_BYTES = 6_291_456;

export type WorkspaceWriteOperation = {
  operation: "add" | "modify";
  path: string;
  mediaType: string;
  encoding: "base64url";
  content: string;
  contentDigest: ReceiptDigest;
  byteLength: number;
  priorContentDigest: ReceiptDigest | null;
};

export type WorkspaceDeleteOperation = {
  operation: "delete";
  path: string;
  priorContentDigest: ReceiptDigest;
};

export type WorkspaceRenameOperation = {
  operation: "rename";
  fromPath: string;
  toPath: string;
  contentDigest: ReceiptDigest;
};

export type WorkspaceChangeOperation =
  | WorkspaceWriteOperation
  | WorkspaceDeleteOperation
  | WorkspaceRenameOperation;

export interface WorkspaceChangeSetArtifact {
  protocol: {
    schema: "agent-airlock/workspace-change-set";
    schemaVersion: 1;
    canonicalization: "RFC8785";
    digestAlgorithm: "SHA-256";
    pathSemantics: "normalized-relative-posix-nfc";
  };
  baseStateDigest: ReceiptDigest;
  resultStateDigest: ReceiptDigest;
  operations: WorkspaceChangeOperation[];
}

export interface WorkspaceChangeSetEnvelope {
  schema: "agent-airlock/workspace-change-set-envelope";
  schemaVersion: 1;
  artifact: WorkspaceChangeSetArtifact;
  artifactDigest: ReceiptDigest;
}

export function buildWorkspaceChangeSetEnvelope(input: {
  baseStateDigest: ReceiptDigest;
  resultStateDigest: ReceiptDigest;
  operations: readonly WorkspaceChangeOperation[];
}): WorkspaceChangeSetEnvelope {
  const artifact: WorkspaceChangeSetArtifact = {
    protocol: {
      schema: "agent-airlock/workspace-change-set",
      schemaVersion: 1,
      canonicalization: "RFC8785",
      digestAlgorithm: "SHA-256",
      pathSemantics: "normalized-relative-posix-nfc",
    },
    baseStateDigest: input.baseStateDigest,
    resultStateDigest: input.resultStateDigest,
    operations: structuredClone([...input.operations]).sort(compareOperations),
  };
  assertWorkspaceChangeSetArtifact(artifact);
  const envelope: WorkspaceChangeSetEnvelope = {
    schema: "agent-airlock/workspace-change-set-envelope",
    schemaVersion: 1,
    artifact,
    artifactDigest: digestWorkspaceChangeSetArtifact(artifact),
  };
  assertWorkspaceChangeSetEnvelope(envelope);
  return envelope;
}

export function digestWorkspaceChangeSetArtifact(
  artifact: WorkspaceChangeSetArtifact,
): ReceiptDigest {
  assertWorkspaceChangeSetArtifact(artifact);
  return sha256Digest(utf8Bytes(canonicalize(artifact)));
}

export function parseWorkspaceChangeSetEnvelopeJson(
  source: string,
  maximumBytes = MAXIMUM_WORKSPACE_CHANGE_SET_BYTES,
): WorkspaceChangeSetEnvelope {
  const value = parseCanonicalJson(source, maximumBytes);
  assertWorkspaceChangeSetEnvelope(value);
  return value;
}

export function assertWorkspaceChangeSetEnvelope(
  value: unknown,
): asserts value is WorkspaceChangeSetEnvelope {
  const envelope = asRecord(value, "Workspace Change Set Envelope");
  assertExactKeys(
    envelope,
    ["schema", "schemaVersion", "artifact", "artifactDigest"],
    "Workspace Change Set Envelope",
  );
  if (
    envelope.schema !== "agent-airlock/workspace-change-set-envelope" ||
    envelope.schemaVersion !== 1 ||
    !isDigest(envelope.artifactDigest)
  ) {
    throw new Error("Workspace Change Set Envelope identity is invalid");
  }
  assertWorkspaceChangeSetArtifact(envelope.artifact);
  const artifact = envelope.artifact as WorkspaceChangeSetArtifact;
  if (envelope.artifactDigest !== digestWorkspaceChangeSetArtifact(artifact)) {
    throw new Error("Workspace Change Set artifact digest does not match its content");
  }
  if (utf8Bytes(canonicalize(envelope)).length > MAXIMUM_WORKSPACE_CHANGE_SET_BYTES) {
    throw new Error("Workspace Change Set Envelope exceeds the byte limit");
  }
}

export function assertWorkspaceChangeSetArtifact(
  value: unknown,
): asserts value is WorkspaceChangeSetArtifact {
  const artifact = asRecord(value, "Workspace Change Set artifact");
  assertExactKeys(
    artifact,
    ["protocol", "baseStateDigest", "resultStateDigest", "operations"],
    "Workspace Change Set artifact",
  );
  const protocol = asRecord(artifact.protocol, "Workspace Change Set protocol");
  assertExactKeys(
    protocol,
    [
      "schema",
      "schemaVersion",
      "canonicalization",
      "digestAlgorithm",
      "pathSemantics",
    ],
    "Workspace Change Set protocol",
  );
  if (
    protocol.schema !== "agent-airlock/workspace-change-set" ||
    protocol.schemaVersion !== 1 ||
    protocol.canonicalization !== "RFC8785" ||
    protocol.digestAlgorithm !== "SHA-256" ||
    protocol.pathSemantics !== "normalized-relative-posix-nfc" ||
    !isDigest(artifact.baseStateDigest) ||
    !isDigest(artifact.resultStateDigest) ||
    !Array.isArray(artifact.operations) ||
    artifact.operations.length > MAXIMUM_WORKSPACE_CHANGE_OPERATIONS
  ) {
    throw new Error("Workspace Change Set protocol or bounds are invalid");
  }
  if (
    (artifact.operations.length === 0) !==
    (artifact.baseStateDigest === artifact.resultStateDigest)
  ) {
    throw new Error("Workspace Change Set operations contradict its state transition");
  }

  const targetPaths = new Set<string>();
  const portableTargetPaths = new Set<string>();
  const renameSources = new Set<string>();
  const portableRenameSources = new Set<string>();
  let totalContentBytes = 0;
  let previousSortKey: string | null = null;
  for (const rawOperation of artifact.operations) {
    const operation = validateOperation(rawOperation);
    const sortKey = operationSortKey(operation);
    if (previousSortKey !== null && previousSortKey >= sortKey) {
      throw new Error("Workspace Change Set operations are not in canonical order");
    }
    previousSortKey = sortKey;
    const targetPath = operation.operation === "rename" ? operation.toPath : operation.path;
    const portableTargetPath = targetPath.toLocaleLowerCase("en-US");
    if (targetPaths.has(targetPath) || portableTargetPaths.has(portableTargetPath)) {
      throw new Error("Workspace Change Set contains a duplicate or case-ambiguous target");
    }
    targetPaths.add(targetPath);
    portableTargetPaths.add(portableTargetPath);
    if (operation.operation === "rename") {
      const portableSourcePath = operation.fromPath.toLocaleLowerCase("en-US");
      if (
        renameSources.has(operation.fromPath) ||
        portableRenameSources.has(portableSourcePath)
      ) {
        throw new Error("Workspace Change Set contains a duplicate rename source");
      }
      renameSources.add(operation.fromPath);
      portableRenameSources.add(portableSourcePath);
    }
    if (operation.operation === "add" || operation.operation === "modify") {
      totalContentBytes += operation.byteLength;
      if (totalContentBytes > MAXIMUM_WORKSPACE_CONTENT_BYTES) {
        throw new Error("Workspace Change Set content exceeds the total byte limit");
      }
    }
  }
  for (const sourcePath of renameSources) {
    if (portableTargetPaths.has(sourcePath.toLocaleLowerCase("en-US"))) {
      throw new Error("Workspace Change Set rename source overlaps a mutation target");
    }
  }
}

export function decodeWorkspaceFileContent(
  operation: WorkspaceWriteOperation,
): Uint8Array {
  validateWriteOperation(operation);
  return Uint8Array.from(Buffer.from(operation.content, "base64url"));
}

function validateOperation(value: unknown): WorkspaceChangeOperation {
  const operation = asRecord(value, "Workspace Change Set operation");
  if (operation.operation === "add" || operation.operation === "modify") {
    return validateWriteOperation(operation);
  }
  if (operation.operation === "delete") {
    assertExactKeys(
      operation,
      ["operation", "path", "priorContentDigest"],
      "Workspace delete operation",
    );
    if (!isDigest(operation.priorContentDigest)) {
      throw new Error("Workspace delete operation digest is invalid");
    }
    assertPortableWorkspacePath(operation.path, "Workspace delete path");
    return operation as WorkspaceDeleteOperation;
  }
  if (operation.operation === "rename") {
    assertExactKeys(
      operation,
      ["operation", "fromPath", "toPath", "contentDigest"],
      "Workspace rename operation",
    );
    if (!isDigest(operation.contentDigest)) {
      throw new Error("Workspace rename operation digest is invalid");
    }
    assertPortableWorkspacePath(operation.fromPath, "Workspace rename source");
    assertPortableWorkspacePath(operation.toPath, "Workspace rename target");
    if (operation.fromPath === operation.toPath) {
      throw new Error("Workspace rename source and target must differ");
    }
    return operation as WorkspaceRenameOperation;
  }
  throw new Error("Workspace Change Set operation kind is unsupported");
}

function validateWriteOperation(value: unknown): WorkspaceWriteOperation {
  const operation = asRecord(value, "Workspace write operation");
  assertExactKeys(
    operation,
    [
      "operation",
      "path",
      "mediaType",
      "encoding",
      "content",
      "contentDigest",
      "byteLength",
      "priorContentDigest",
    ],
    "Workspace write operation",
  );
  if (
    !["add", "modify"].includes(String(operation.operation)) ||
    typeof operation.mediaType !== "string" ||
    !/^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/.test(
      operation.mediaType,
    ) ||
    operation.encoding !== "base64url" ||
    typeof operation.content !== "string" ||
    !isDigest(operation.contentDigest) ||
    !Number.isSafeInteger(operation.byteLength) ||
    (operation.byteLength as number) < 0 ||
    (operation.byteLength as number) > MAXIMUM_WORKSPACE_FILE_BYTES
  ) {
    throw new Error("Workspace write operation fields or bounds are invalid");
  }
  if (
    (operation.operation === "add" && operation.priorContentDigest !== null) ||
    (operation.operation === "modify" && !isDigest(operation.priorContentDigest))
  ) {
    throw new Error("Workspace write operation prior digest is invalid");
  }
  assertPortableWorkspacePath(operation.path, "Workspace write path");
  const decoded = decodeCanonicalBase64Url(operation.content);
  if (decoded.length !== operation.byteLength) {
    throw new Error("Workspace write operation byte length does not match content");
  }
  if (sha256Digest(decoded) !== operation.contentDigest) {
    throw new Error("Workspace write operation digest does not match content");
  }
  return operation as WorkspaceWriteOperation;
}

function assertPortableWorkspacePath(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.normalize("NFC") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes("//") ||
    /^[A-Za-z]:/.test(value) ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    utf8Bytes(value).length > 1_024
  ) {
    throw new Error(`${name} is not normalized relative POSIX NFC`);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        segment === ".git" ||
        segment === ".agent-airlock" ||
        utf8Bytes(segment).length > 255,
    )
  ) {
    throw new Error(`${name} contains a reserved, traversal, or oversized segment`);
  }
}

function decodeCanonicalBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.includes("=")) {
    throw new Error("Workspace file content is not canonical base64url");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error("Workspace file content is not canonical base64url");
  }
  return Uint8Array.from(decoded);
}

function compareOperations(left: WorkspaceChangeOperation, right: WorkspaceChangeOperation): number {
  const leftKey = operationSortKey(left);
  const rightKey = operationSortKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function operationSortKey(operation: WorkspaceChangeOperation): string {
  if (operation.operation === "rename") {
    return `${operation.toPath}\u0000rename\u0000${operation.fromPath}`;
  }
  return `${operation.path}\u0000${operation.operation}`;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new Error(`${name} has unknown or missing fields`);
  }
}
