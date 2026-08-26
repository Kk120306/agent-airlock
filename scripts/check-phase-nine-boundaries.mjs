import { readFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(".");
const failures = [];
const selection = await source("apps/server/src/candidate-selection.ts");
const runner = await source("apps/server/src/airlock-runner.ts");
const routes = await source("apps/server/src/app.ts");
const store = await source("apps/server/src/store.ts");
const types = await source("apps/server/src/types.ts");

for (const specifier of importSpecifiers(selection)) {
  if (specifier !== "node:crypto" && specifier !== "./types.js") {
    failures.push("Selection imports disallowed module " + specifier);
  }
}

const nondeterministicSelectionPatterns = [
  ["current time", /\bDate\b|Date\.now/],
  ["randomness", /Math\.random|randomUUID|randomBytes/],
  ["locale ordering", /localeCompare|Intl\./],
  ["ambient configuration", /process\.env/],
  ["network access", /\bfetch\s*\(|node:(?:http|https|net)/],
  ["filesystem access", /node:fs|readFile|writeFile|readdir/],
];
for (const [label, pattern] of nondeterministicSelectionPatterns) {
  if (pattern.test(selection)) {
    failures.push("Selection depends on " + label);
  }
}

const deferredIndex = runner.indexOf("if (options.deferPromotionFor)");
const planIndex = runner.indexOf("this.resources.planAll", deferredIndex);
const journalIndex = runner.indexOf("this.promotionJournal.begin", deferredIndex);
if (deferredIndex < 0 || planIndex < 0 || journalIndex < 0) {
  failures.push("AirlockRunner does not expose the sealed Candidate boundary");
} else if (deferredIndex > planIndex || deferredIndex > journalIndex) {
  failures.push("AirlockRunner starts irreversible Promotion before Selection deferral");
}
for (const operation of ["promoteSealedCandidate", "disposeSealedCandidate"]) {
  if (!runner.includes("async " + operation + "(")) {
    failures.push("AirlockRunner is missing " + operation);
  }
}

for (const route of [
  'app.get("/api/agents/:id/candidate-sets"',
  'app.post("/api/agents/:id/candidate-sets"',
  'app.get("/api/candidate-sets/:id"',
  'app.post("/api/candidate-sets/:id/cancel"',
]) {
  if (!routes.includes(route)) failures.push("HTTP boundary is missing " + route);
}

if (!/version:\s*9\b/.test(store) || !store.includes("candidateSets: []")) {
  failures.push("Database version 9 does not initialize Candidate Sets");
}
if (!/version:\s*9;/.test(types) || !types.includes("candidateSets: CandidateSet[]")) {
  failures.push("Database type does not require the Candidate Set aggregate");
}

if (failures.length > 0) {
  process.stderr.write(
    "Phase 9 boundary check failed:\n" +
      failures.map((failure) => "- " + failure).join("\n") +
      "\n",
  );
  process.exit(1);
}

process.stdout.write(
  "Phase 9 boundaries passed: deterministic Selection, reversible evaluation before Promotion, explicit winner lifecycle, versioned persistence, and bounded HTTP routes.\n",
);

async function source(relativePath) {
  return readFile(path.join(projectRoot, relativePath), "utf8");
}

function importSpecifiers(content) {
  return [
    ...content.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/g),
  ].map((match) => match[2]);
}
