import { createHash } from "node:crypto";

const approvedModelArkBoundaryDigests = Object.freeze({
  "README.md":
    "sha256:8784f42ca16951fe93e968bb7046a61e5b315110252595948169797fb6f9b41d",
  "docs/demo/DEVPOST_SUBMISSION.md":
    "sha256:7b868460633f40e508f39acacd9c3d089783d8255459a3e178f95e9da2f231e0",
  "docs/demo/SUBMISSION_BRIEF.md":
    "sha256:aa54f584fe0dfd004fb075ce4731420144d04086aed0c30bf0b0a8d6878e6494",
  "docs/demo/JUDGE_CHECKLIST.md":
    "sha256:c6c3730b0814ca1980216d8d3b6ac99b5ee66024d3e9824f9a6ea8099e93db73",
  "docs/product/PRD.md":
    "sha256:d3047a6a9fef24406adb0c39fee7cc26588e10cf33fee08c40d9e9e6afcd59af",
  "docs/product/OUTCOME_ROADMAP.md":
    "sha256:268f7a76ce8ec97b8a9992d211115050d49adcc849b74680b85be00a8495d8a7",
  "docs/demo/three-minute-demo.md":
    "sha256:4538a4cdcaf44b57d545005cd30ef587773f68a5f2573c7a5fdbef712434ced9",
  "docs/demo/architecture-one-page.md":
    "sha256:644627912a45d563a7217ee8ed377c6c64bdc436d8cbec58a7e8e971d6d19d6c",
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
