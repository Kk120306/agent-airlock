import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  approvedModelArkBoundaryDocument,
  approvedModelArkBoundaryDocuments,
  MODELARK_BOUNDARY_FILES,
} from "./modelark-claim-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const approvedEntries = await Promise.all(
  MODELARK_BOUNDARY_FILES.map(async (file) => [
    file,
    await readFile(path.join(root, file), "utf8"),
  ]),
);

test("approves the exact ModelArk boundary in all eight submission documents", () => {
  assert.equal(approvedEntries.length, 8);
  assert.equal(approvedModelArkBoundaryDocuments(approvedEntries), true);
  for (const [file, content] of approvedEntries) {
    assert.equal(approvedModelArkBoundaryDocument(file, content), true, file);
  }
});

for (const bypass of [
  "Live ModelArk succeeded.",
  "BytePlus ModelArk is production-proven.",
  "ModelArk achieved a real provider-backed Run.",
  "Live ModelArk conformance succeeded, but this is not BytePlus-signed.",
]) {
  test(`rejects reviewer bypass in every document: ${bypass}`, () => {
    for (const [file, content] of approvedEntries) {
      const changedContent = `${content}\n${bypass}\n`;
      const changedEntries = approvedEntries.map(([entryFile, entryContent]) =>
        entryFile === file ? [entryFile, changedContent] : [entryFile, entryContent],
      );

      assert.equal(
        approvedModelArkBoundaryDocument(file, changedContent),
        false,
        file,
      );
      assert.equal(approvedModelArkBoundaryDocuments(changedEntries), false, file);
    }
  });
}

test("rejects a document set with an approved document missing", () => {
  assert.equal(approvedModelArkBoundaryDocuments(approvedEntries.slice(1)), false);
});

test("allows only the intentional dynamic YouTube value in Devpost copy", () => {
  const changedEntries = approvedEntries.map(([file, content]) => [
    file,
    file === "docs/demo/DEVPOST_SUBMISSION.md"
      ? content.replace(
          "- Public three-minute demo video: `[INSERT PUBLIC YOUTUBE URL]`",
          "- Public three-minute demo video: https://youtu.be/abc123xyz",
        )
      : content,
  ]);
  assert.equal(approvedModelArkBoundaryDocuments(changedEntries), true);
});

test("rejects commentary appended to the dynamic YouTube field", () => {
  const changedEntries = approvedEntries.map(([file, content]) => [
    file,
    file === "docs/demo/DEVPOST_SUBMISSION.md"
      ? content.replace(
          "- Public three-minute demo video: `[INSERT PUBLIC YOUTUBE URL]`",
          "- Public three-minute demo video: https://youtu.be/abc123xyz Live ModelArk succeeded.",
        )
      : content,
  ]);
  assert.equal(approvedModelArkBoundaryDocuments(changedEntries), false);
});
