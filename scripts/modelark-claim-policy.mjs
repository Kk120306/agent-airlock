import { createHash } from "node:crypto";

const approvedModelArkBoundaryDigests = Object.freeze({
  "README.md":
    "sha256:105a3eaf79f1a21d8cdecd8129c8eaf157c4e6b73513a139c740e0c9b477f6d4",
  "docs/demo/DEVPOST_SUBMISSION.md":
    "sha256:d31cd6ee6d0194ea75da63e0913560db7d0ff034f1954f1834dca5ce8d31e9cf",
  "docs/demo/SUBMISSION_BRIEF.md":
    "sha256:6b809ae7f9367cfd8b0ee7697a3447c89de5fccf3f9753b5f135a1e1e0015f02",
  "docs/demo/JUDGE_CHECKLIST.md":
    "sha256:5569019d482904ddd00d1e153e597dc9ef082c044c675473cbbef78edd96692b",
  "docs/product/PRD.md":
    "sha256:2fdf31be8756989e055e4c7febd69a1295e168976f71711277a9f49e57adcda5",
  "docs/product/OUTCOME_ROADMAP.md":
    "sha256:591452db39ae0a56e2837a502f9752bf670dd625d17cab14ac4d82d328c3ebca",
  "docs/demo/three-minute-demo.md":
    "sha256:fdcc7759f1d899c464422a2c3b70bdb5d0d68f70f7484388f2aed19b7f7657d2",
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
