import { access, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const liveModelArkEvidenceDirectoryName = "conformance-evidence";
export const liveModelArkLatestEvidenceName = "modelark-live-latest.packet.json";

const requiredResourceKinds = [
  "workspace",
  "codex-session",
  "sqlite",
  "external-actions",
];

export function isCompleteLiveModelArkPromotion(run) {
  const transaction = run?.transaction;
  if (!transaction || transaction.disposition !== "promoted") return false;
  const executionProfile = transaction.validations?.find(
    (validation) => validation.name === "execution-profile",
  );
  const liveStateValidation = transaction.validations?.find(
    (validation) => validation.name === "modelark-live-state",
  );
  const promotedResources = new Set(
    (transaction.resources ?? [])
      .filter((resource) => resource.disposition === "promoted")
      .map((resource) => resource.kind),
  );
  const databaseValue = transaction.sqlite?.after?.rows?.find(
    (row) => row.id === "demo",
  )?.value;
  const intents = transaction.externalActions?.intents ?? [];
  return (
    executionProfile?.required === true &&
    executionProfile.status === "passed" &&
    executionProfile.summary?.includes("configured ModelArk Responses profile") &&
    liveStateValidation?.required === true &&
    liveStateValidation.status === "passed" &&
    databaseValue === "modelark-live" &&
    transaction.externalActions?.deliveredCount === 1 &&
    intents.length === 1 &&
    intents[0]?.id === "modelark-live-ready" &&
    intents[0]?.status === "delivered" &&
    requiredResourceKinds.every((kind) => promotedResources.has(kind))
  );
}

function evidencePathForRun(stateRoot, runId) {
  return path.join(
    stateRoot,
    liveModelArkEvidenceDirectoryName,
    `modelark-live-${runId}.packet.json`,
  );
}

async function exists(filePath) {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

async function requestJson(baseUrl, pathname, options, fetchImpl, signal) {
  const timeout = AbortSignal.timeout(5_000);
  const response = await fetchImpl(baseUrl + pathname, {
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${pathname}`);
  return response.json();
}

function assertSafeCapturedPacket(exported, runId, disclosureIdentity) {
  const packet = exported?.packet;
  const envelope = packet?.envelope;
  if (
    exported?.verification?.valid !== true ||
    packet?.schema !== "agent-airlock/portable-evidence-packet" ||
    envelope?.receipt?.decision?.runId !== runId ||
    envelope.receipt.decision.disposition !== "promoted" ||
    !envelope.disclosures?.some(
      (disclosure) => disclosure.leaf?.identity === disclosureIdentity,
    )
  ) {
    throw new Error("The live ModelArk evidence packet did not pass capture admission");
  }
  const serialized = JSON.stringify(packet, null, 2) + "\n";
  if (
    /Bearer\s|ARK_API_KEY|api[_-]?key\s*[=:]|https?:\/\/|\bep-[A-Za-z0-9]|\bark-[A-Za-z0-9]/i.test(
      serialized,
    )
  ) {
    throw new Error("The live ModelArk evidence packet contains forbidden private material");
  }
  return serialized;
}

async function writePrivateAtomic(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, filePath);
}

export async function captureLiveModelArkConformance({
  baseUrl,
  agentId,
  stateRoot,
  fetchImpl = fetch,
  signal,
}) {
  const { runs } = await requestJson(
    baseUrl,
    `/api/agents/${agentId}/runs`,
    {},
    fetchImpl,
    signal,
  );
  for (const run of runs) {
    if (!isCompleteLiveModelArkPromotion(run)) continue;
    const artifactPath = evidencePathForRun(stateRoot, run.id);
    if (await exists(artifactPath)) continue;
    const preview = await requestJson(
      baseUrl,
      `/api/runs/${run.id}/portable-receipt`,
      {
        method: "POST",
        body: JSON.stringify({
          disclosureIdentities: [],
          includeAncestry: false,
          localAnchor: false,
          evmPayload: false,
        }),
      },
      fetchImpl,
      signal,
    );
    const executionProfile = preview.availableDisclosures?.find(
      (disclosure) =>
        disclosure.required === true &&
        disclosure.status === "passed" &&
        disclosure.summary?.includes("configured ModelArk Responses profile"),
    );
    if (!executionProfile) {
      throw new Error("The live ModelArk execution-profile disclosure is unavailable");
    }
    const exported = await requestJson(
      baseUrl,
      `/api/runs/${run.id}/portable-receipt`,
      {
        method: "POST",
        body: JSON.stringify({
          disclosureIdentities: [executionProfile.identity],
          includeAncestry: false,
          localAnchor: false,
          evmPayload: false,
        }),
      },
      fetchImpl,
      signal,
    );
    const serialized = assertSafeCapturedPacket(
      exported,
      run.id,
      executionProfile.identity,
    );
    await writePrivateAtomic(artifactPath, serialized);
    await writePrivateAtomic(
      path.join(
        stateRoot,
        liveModelArkEvidenceDirectoryName,
        liveModelArkLatestEvidenceName,
      ),
      serialized,
    );
    return {
      runId: run.id,
      artifactPath,
      relativePath: path.join(
        liveModelArkEvidenceDirectoryName,
        path.basename(artifactPath),
      ),
    };
  }
  return null;
}

export async function monitorLiveModelArkConformance({
  baseUrl,
  agentId,
  stateRoot,
  signal,
  fetchImpl = fetch,
  intervalMs = 750,
  onCaptured = () => {},
  onError = () => {},
}) {
  let lastError = null;
  while (!signal.aborted) {
    try {
      const captured = await captureLiveModelArkConformance({
        baseUrl,
        agentId,
        stateRoot,
        fetchImpl,
        signal,
      });
      if (captured) onCaptured(captured);
      lastError = null;
    } catch (error) {
      if (signal.aborted) break;
      const errorClass = error instanceof Error ? error.name : "UnknownError";
      if (errorClass !== lastError) onError();
      lastError = errorClass;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
