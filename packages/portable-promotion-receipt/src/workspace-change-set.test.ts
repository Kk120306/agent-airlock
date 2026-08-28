import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { sha256Digest } from "./crypto.js";
import type {
  WorkspaceChangeOperation,
  WorkspaceChangeSetEnvelope,
  WorkspaceWriteOperation,
} from "./workspace-change-set.js";
import {
  buildWorkspaceChangeSetEnvelope,
  decodeWorkspaceFileContent,
  parseWorkspaceChangeSetEnvelopeJson,
} from "./workspace-change-set.js";

const digest = (marker: string) => sha256Digest(Buffer.from(marker, "utf8"));

function write(
  operation: "add" | "modify",
  path: string,
  content: string,
): WorkspaceWriteOperation {
  const bytes = Buffer.from(content, "utf8");
  return {
    operation,
    path,
    mediaType: "text/plain",
    encoding: "base64url",
    content: bytes.toString("base64url"),
    contentDigest: sha256Digest(bytes),
    byteLength: bytes.length,
    priorContentDigest: operation === "add" ? null : digest("prior:" + path),
  };
}

function envelope(
  operations: readonly WorkspaceChangeOperation[],
): WorkspaceChangeSetEnvelope {
  const baseStateDigest = digest("base");
  return buildWorkspaceChangeSetEnvelope({
    baseStateDigest,
    resultStateDigest: operations.length === 0 ? baseStateDigest : digest("result"),
    operations,
  });
}

describe("portable workspace change-set protocol", () => {
  it("canonicalizes add, modify, delete, rename, empty, and binary changes", () => {
    const binary = Buffer.from([0, 1, 2, 253, 254, 255]);
    const operations: WorkspaceChangeOperation[] = [
      {
        operation: "rename",
        fromPath: "docs/old.md",
        toPath: "docs/new.md",
        contentDigest: digest("renamed"),
      },
      write("modify", "README.md", "updated\n"),
      {
        operation: "delete",
        path: "obsolete.txt",
        priorContentDigest: digest("obsolete"),
      },
      write("add", "notes/empty.txt", ""),
      {
        operation: "add",
        path: "assets/blob.bin",
        mediaType: "application/octet-stream",
        encoding: "base64url",
        content: binary.toString("base64url"),
        contentDigest: sha256Digest(binary),
        byteLength: binary.length,
        priorContentDigest: null,
      },
    ];

    const built = envelope(operations);
    const parsed = parseWorkspaceChangeSetEnvelopeJson(JSON.stringify(built));
    expect(parsed).toEqual(built);
    expect(parsed.artifact.operations.map((item) =>
      item.operation === "rename" ? item.toPath : item.path,
    )).toEqual([
      "README.md",
      "assets/blob.bin",
      "docs/new.md",
      "notes/empty.txt",
      "obsolete.txt",
    ]);
    expect(decodeWorkspaceFileContent(parsed.artifact.operations[1] as WorkspaceWriteOperation))
      .toEqual(Uint8Array.from(binary));
    expect(envelope([]).artifact.operations).toEqual([]);
  });

  it("rejects state transitions that contradict whether work is present", () => {
    expect(() => buildWorkspaceChangeSetEnvelope({
      baseStateDigest: digest("same"),
      resultStateDigest: digest("different"),
      operations: [],
    })).toThrow(/contradict/);
    expect(() => buildWorkspaceChangeSetEnvelope({
      baseStateDigest: digest("same"),
      resultStateDigest: digest("same"),
      operations: [write("add", "new.txt", "new")],
    })).toThrow(/contradict/);
  });

  it("rejects traversal, absolute, platform-specific, reserved, and non-normalized paths", () => {
    for (const path of [
      "../escape.txt",
      "/absolute.txt",
      "C:/windows.txt",
      "nested\\windows.txt",
      "nested//empty.txt",
      "nested/./dot.txt",
      "repo/.git/config",
      "repo/.agent-airlock/state.json",
      "cafe\u0301.txt",
    ]) {
      expect(() => envelope([write("add", path, "unsafe")])).toThrow();
    }
  });

  it("rejects duplicate, case-ambiguous, and unordered mutation targets", () => {
    expect(() => envelope([
      write("add", "same.txt", "one"),
      { operation: "delete", path: "same.txt", priorContentDigest: digest("prior") },
    ])).toThrow(/duplicate or case-ambiguous target/);
    expect(() => envelope([
      write("add", "Readme.md", "one"),
      write("add", "README.md", "two"),
    ])).toThrow(/duplicate or case-ambiguous target/);
    expect(() => envelope([
      {
        operation: "rename",
        fromPath: "source.txt",
        toPath: "renamed.txt",
        contentDigest: digest("source"),
      },
      write("modify", "source.txt", "changed"),
    ])).toThrow(/rename source overlaps a mutation target/);
    expect(() => envelope([
      {
        operation: "rename",
        fromPath: "source.txt",
        toPath: "one.txt",
        contentDigest: digest("source"),
      },
      {
        operation: "rename",
        fromPath: "SOURCE.txt",
        toPath: "two.txt",
        contentDigest: digest("source"),
      },
    ])).toThrow(/duplicate rename source/);

    const unordered = structuredClone(envelope([
      write("add", "a.txt", "a"),
      write("add", "b.txt", "b"),
    ]));
    unordered.artifact.operations.reverse();
    expect(() => parseWorkspaceChangeSetEnvelopeJson(JSON.stringify(unordered)))
      .toThrow(/canonical order/);
  });

  it("rejects content, digest, length, prior-state, and envelope contradictions", () => {
    const cases = [
      (value: WorkspaceChangeSetEnvelope) => {
        (value.artifact.operations[0] as WorkspaceWriteOperation).content = "dGFtcGVyZWQ";
      },
      (value: WorkspaceChangeSetEnvelope) => {
        (value.artifact.operations[0] as WorkspaceWriteOperation).contentDigest = digest("wrong");
      },
      (value: WorkspaceChangeSetEnvelope) => {
        (value.artifact.operations[0] as WorkspaceWriteOperation).byteLength += 1;
      },
      (value: WorkspaceChangeSetEnvelope) => {
        (value.artifact.operations[0] as WorkspaceWriteOperation).priorContentDigest = digest("unexpected");
      },
      (value: WorkspaceChangeSetEnvelope) => {
        value.artifactDigest = digest("wrong-envelope");
      },
    ];
    for (const mutate of cases) {
      const value = envelope([write("add", "safe.txt", "safe")]);
      mutate(value);
      expect(() => parseWorkspaceChangeSetEnvelopeJson(JSON.stringify(value))).toThrow();
    }
  });

  it("rejects unknown fields, duplicate JSON keys, and non-canonical base64url", () => {
    const value = envelope([write("add", "safe.txt", "safe")]);
    (value as unknown as Record<string, unknown>).trusted = true;
    expect(() => parseWorkspaceChangeSetEnvelopeJson(JSON.stringify(value)))
      .toThrow(/unknown or missing fields/);

    const source = JSON.stringify(envelope([]));
    expect(() => parseWorkspaceChangeSetEnvelopeJson(
      source.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    )).toThrow(/duplicate key/);

    const padded = envelope([write("add", "safe.txt", "safe")]);
    (padded.artifact.operations[0] as WorkspaceWriteOperation).content += "=";
    expect(() => parseWorkspaceChangeSetEnvelopeJson(JSON.stringify(padded)))
      .toThrow(/canonical base64url/);
  });
});
