import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPortableEvidencePacketJson } from "@agent-airlock/portable-promotion-receipt";
import {
  liveModelArkEvidenceDirectoryName,
  liveModelArkLatestEvidenceName,
} from "./modelark-conformance-evidence.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const stateRoot = path.resolve(
  process.env.AIRLOCK_MODELARK_DEMO_DATA_ROOT ??
    path.join(projectRoot, ".local", "airlock-modelark-demo"),
);
const evidencePath = path.join(
  stateRoot,
  liveModelArkEvidenceDirectoryName,
  liveModelArkLatestEvidenceName,
);

async function readBoundedRegularFile(filePath) {
  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 2_097_152) {
      throw new Error("Recorded ModelArk evidence must be a bounded regular file");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

try {
  const source = await readBoundedRegularFile(evidencePath);
  const report = verifyPortableEvidencePacketJson(source);
  const packet = JSON.parse(source);
  const receipt = packet?.envelope?.receipt;
  const providerDisclosure = packet?.envelope?.disclosures?.find(
    (disclosure) =>
      disclosure.leaf?.required === true &&
      disclosure.leaf?.status === "passed" &&
      disclosure.leaf?.summary?.includes("configured ModelArk Responses profile"),
  );
  const valid =
    report.valid &&
    receipt?.decision?.disposition === "promoted" &&
    Boolean(providerDisclosure);
  console.log(`Recorded live ModelArk conformance: ${valid ? "VALID" : "INVALID"}`);
  console.log("This verifies historical signed evidence, not current provider availability.");
  console.log(`Signed decisions: 1`);
  console.log(`Receipt digest: ${report.receipt.receiptDigest ?? "unavailable"}`);
  console.log(`Execution profile disclosed: ${providerDisclosure ? "yes" : "no"}`);
  if (!valid) process.exitCode = 1;
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
