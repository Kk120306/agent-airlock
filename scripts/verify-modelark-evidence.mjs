import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyRecordedLiveModelArkEvidence } from "./modelark-recorded-evidence.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const stateRoot = path.resolve(
  process.env.AIRLOCK_MODELARK_DEMO_DATA_ROOT ??
    path.join(projectRoot, ".local", "airlock-modelark-demo"),
);
try {
  const result = await verifyRecordedLiveModelArkEvidence({ stateRoot });
  console.log(
    `Recorded live ModelArk conformance: ${result.valid ? "VALID" : "INVALID"}`,
  );
  console.log("This verifies historical signed evidence, not current provider availability.");
  console.log(`Signed decisions: 1`);
  console.log(`Receipt digest: ${result.receiptDigest ?? "unavailable"}`);
  console.log(
    `Execution profile disclosed: ${result.executionProfileDisclosed ? "yes" : "no"}`,
  );
  if (!result.valid) process.exitCode = 1;
} catch (error) {
  if (error?.code === "ENOENT") {
    console.error(
      "No recorded live ModelArk conformance evidence is available. Complete Run live Candidate when free provider capacity returns.",
    );
  } else {
    console.error(
      "Recorded live ModelArk conformance evidence could not be verified safely.",
    );
  }
  process.exitCode = 1;
}
