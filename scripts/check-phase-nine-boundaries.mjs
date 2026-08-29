import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

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

const databaseInitializer = inspectEmptyDatabase(store);
if (
  !databaseInitializer ||
  databaseInitializer.version < 9 ||
  !databaseInitializer.initializesCandidateSets
) {
  failures.push("Database version 9 does not initialize Candidate Sets");
}
const databaseContract = inspectDatabaseContract(types);
if (
  !databaseContract ||
  databaseContract.version < 9 ||
  !databaseContract.requiresCandidateSets
) {
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

function inspectDatabaseContract(content) {
  const file = ts.createSourceFile(
    "types.ts",
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = file.statements.find(
    (statement) =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === "Database",
  );
  if (!declaration || !ts.isInterfaceDeclaration(declaration)) return null;
  const version = declaration.members.find(
    (member) => ts.isPropertySignature(member) && member.name.getText(file) === "version",
  );
  const candidateSets = declaration.members.find(
    (member) =>
      ts.isPropertySignature(member) && member.name.getText(file) === "candidateSets",
  );
  if (
    !version ||
    !ts.isPropertySignature(version) ||
    !version.type ||
    !ts.isLiteralTypeNode(version.type) ||
    !ts.isNumericLiteral(version.type.literal)
  ) {
    return null;
  }
  return {
    version: Number(version.type.literal.text),
    requiresCandidateSets:
      Boolean(candidateSets) &&
      ts.isPropertySignature(candidateSets) &&
      candidateSets.questionToken === undefined &&
      candidateSets.type?.getText(file) === "CandidateSet[]",
  };
}

function inspectEmptyDatabase(content) {
  const file = ts.createSourceFile(
    "store.ts",
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== "emptyDatabase" ||
        !declaration.initializer ||
        !ts.isArrowFunction(declaration.initializer)
      ) {
        continue;
      }
      let body = declaration.initializer.body;
      while (ts.isParenthesizedExpression(body)) body = body.expression;
      if (!ts.isObjectLiteralExpression(body)) return null;
      const properties = new Map(
        body.properties.flatMap((property) =>
          ts.isPropertyAssignment(property)
            ? [[property.name.getText(file), property.initializer]]
            : [],
        ),
      );
      const version = properties.get("version");
      const candidateSets = properties.get("candidateSets");
      if (!version || !ts.isNumericLiteral(version)) return null;
      return {
        version: Number(version.text),
        initializesCandidateSets:
          Boolean(candidateSets) &&
          ts.isArrayLiteralExpression(candidateSets) &&
          candidateSets.elements.length === 0,
      };
    }
  }
  return null;
}
