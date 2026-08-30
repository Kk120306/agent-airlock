import { createHash } from "node:crypto";

const approvedModelArkBoundaryDigests = Object.freeze({
  "README.md":
    "sha256:07b95f357cc0650333db91427ea3ac0ab7d3de8cd11ad186a1c51648de076952",
  "docs/demo/DEVPOST_SUBMISSION.md":
    "sha256:1d2a4b0422d6996f01b08ead90ac04dcfbce34fe0d736ecbf272b26f7f2f0a9a",
  "docs/demo/SUBMISSION_BRIEF.md":
    "sha256:daec5fb307470eac5948ca71d7dd3d5e946c0360f02067c02bff64a329acdaf2",
  "docs/demo/JUDGE_CHECKLIST.md":
    "sha256:787b18c8733a4b4ba94e55091fb4d7699d0e05564d8675cb9a77861c858171cc",
  "docs/product/PRD.md":
    "sha256:1ac0e2b29f8d18f6caf51c6eb1d1be7559c86f3aeeba844624280e2b7884465d",
  "docs/product/OUTCOME_ROADMAP.md":
    "sha256:5f29c2d611df068123119ef04974641e35eb9d294b9903a63c7ed847d7cfc3a9",
  "docs/demo/three-minute-demo.md":
    "sha256:4167aee46e267b2e73ac4561f8d1175344f3cfa5072a753957962efaf69dfc28",
  "docs/demo/architecture-one-page.md":
    "sha256:a39246e8dbc4e1fff74b4f1cb8d0992d73a2cd27db3d321d99a9f7dcc1b23e70",
});

export const MODELARK_BOUNDARY_FILES = Object.freeze(
  Object.keys(approvedModelArkBoundaryDigests),
);

const dynamicVideoPrefix = "- Public three-minute demo video: ";
const dynamicVideoPlaceholder =
  "- Public three-minute demo video: `[INSERT PUBLIC YOUTUBE URL]`";

function approvedDynamicVideoLine(line) {
  if (line === dynamicVideoPlaceholder) return true;
  if (!line.startsWith(dynamicVideoPrefix)) return false;
  const rawUrl = line.slice(dynamicVideoPrefix.length);
  if (rawUrl !== rawUrl.trim() || /\s/.test(rawUrl)) return false;
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      ((host === "youtube.com" &&
        ((url.pathname === "/watch" && Boolean(url.searchParams.get("v"))) ||
          /^\/shorts\/[^/]+$/.test(url.pathname))) ||
        (host === "youtu.be" && /^\/[^/]+$/.test(url.pathname)))
    );
  } catch {
    return false;
  }
}

export function modelArkBoundaryDigest(file, content) {
  if (typeof content !== "string") return null;

  const boundary = content
    .split(/\r?\n/)
    .map((line) =>
      file === "docs/demo/DEVPOST_SUBMISSION.md" &&
      approvedDynamicVideoLine(line)
        ? "- Public three-minute demo video: <approved-dynamic-youtube-url>"
        : line,
    )
    .join("\n");

  return `sha256:${createHash("sha256").update(boundary).digest("hex")}`;
}

export function approvedModelArkBoundaryDocument(file, content) {
  const approvedDigest = approvedModelArkBoundaryDigests[file];
  return (
    approvedDigest !== undefined &&
    modelArkBoundaryDigest(file, content) === approvedDigest
  );
}

export function approvedModelArkBoundaryDocuments(entries) {
  if (!Array.isArray(entries) || entries.length !== MODELARK_BOUNDARY_FILES.length) {
    return false;
  }

  const files = new Set(entries.map(([file]) => file));
  return (
    files.size === MODELARK_BOUNDARY_FILES.length &&
    MODELARK_BOUNDARY_FILES.every((file) => files.has(file)) &&
    entries.every(([file, content]) =>
      approvedModelArkBoundaryDocument(file, content),
    )
  );
}
