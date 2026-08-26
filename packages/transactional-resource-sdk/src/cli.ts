#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  runTransactionalResourceConformance,
  type ResourceConformanceFixtureFactory,
} from "./conformance.js";
import { redactSensitiveText } from "./validation.js";

const argumentsList = process.argv.slice(2);

if (argumentsList.includes("--help") || argumentsList.includes("-h")) {
  process.stdout.write(
    [
      "Usage: agent-airlock-resource-conformance <module>",
      "",
      "The module must export createConformanceFixture or a default fixture factory.",
      "Human-readable evidence is written to stderr and JSON evidence is written to stdout.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

if (argumentsList.length !== 1) {
  process.stderr.write(
    "Expected exactly one provider conformance fixture module. Use --help for usage.\n",
  );
  process.exit(2);
}

try {
  const moduleSpecifier = resolveModuleSpecifier(argumentsList[0]!);
  const loaded = (await import(moduleSpecifier)) as Record<string, unknown>;
  const factory = loaded.createConformanceFixture ?? loaded.default;
  if (typeof factory !== "function") {
    throw new Error(
      "Provider module must export createConformanceFixture or a default fixture factory",
    );
  }
  const report = await runTransactionalResourceConformance(
    factory as ResourceConformanceFixtureFactory,
  );
  process.stderr.write(renderHumanReport(report));
  process.stdout.write(JSON.stringify(report) + "\n");
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  process.stderr.write(
    "Conformance command failed: " +
      boundMessage(error instanceof Error ? error.message : String(error)) +
      "\n",
  );
  process.exitCode = 2;
}

function resolveModuleSpecifier(value: string): string {
  if (value.startsWith(".") || path.isAbsolute(value)) {
    return pathToFileURL(path.resolve(process.cwd(), value)).href;
  }
  return value;
}

function renderHumanReport(report: Awaited<ReturnType<typeof runTransactionalResourceConformance>>): string {
  const lines = [
    "Transactional Resource conformance: " +
      (report.passed ? "PASSED" : "FAILED"),
    "Provider: " +
      report.provider.label +
      " (" +
      report.provider.providerId +
      ")",
  ];
  for (const item of report.cases) {
    lines.push(
      "[" + item.status.toUpperCase() + "] " + item.id + " - " + item.summary,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function boundMessage(message: string): string {
  const flattened = redactSensitiveText(message).replaceAll(/[\r\n]+/g, " ");
  return flattened.length <= 512 ? flattened : flattened.slice(0, 509) + "...";
}
