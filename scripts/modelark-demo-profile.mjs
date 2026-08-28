import os from "node:os";
import path from "node:path";

export const liveModelArkAgentName = "Live ModelArk Proof";
export const liveModelArkPrompt =
  "Create modelark-proof.txt containing exactly modelark-live followed by a newline. Use no dependencies. Verify the file content before finishing.";

export const liveModelArkContract = Object.freeze({
  requiredPaths: ["AGENTS.md", "modelark-proof.txt"],
  protectedPaths: ["AGENTS.md"],
  maxChangedFiles: 4,
  maxAddedBytes: 4_096,
  secretPatterns: [],
  validationCommands: [
    {
      name: "modelark-live-content",
      command: 'test "$(cat modelark-proof.txt)" = modelark-live',
      required: true,
      timeoutMs: 10_000,
    },
  ],
});

export function assertSafeManagedRoot(projectRoot, stateRoot) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedStateRoot = path.resolve(stateRoot);
  const forbidden = new Set([
    path.parse(resolvedStateRoot).root,
    resolvedProjectRoot,
    os.homedir(),
  ]);
  if (forbidden.has(resolvedStateRoot) || path.dirname(resolvedStateRoot) === resolvedStateRoot) {
    throw new Error("Refusing to use an unsafe ModelArk demo data root: " + resolvedStateRoot);
  }
  return resolvedStateRoot;
}

export function comparableContract(contract) {
  return {
    requiredPaths: contract.requiredPaths,
    protectedPaths: contract.protectedPaths,
    maxChangedFiles: contract.maxChangedFiles,
    maxAddedBytes: contract.maxAddedBytes,
    secretPatterns: contract.secretPatterns,
    validationCommands: contract.validationCommands,
  };
}

export function buildLiveModelArkDemoEnvironment(
  baseEnvironment,
  { host, port, stateRoot },
) {
  return {
    ...baseEnvironment,
    HOST: host,
    PORT: String(port),
    LOCAL_POC_DATA_ROOT: stateRoot,
    AIRLOCK_DEMO_MODE: "false",
    AIRLOCK_PROTOCOL_FIXTURE_MODE: "false",
    AIRLOCK_MODELARK_DEMO_MODE: "true",
    AIRLOCK_SKIP_MODELARK_PREFLIGHT: "false",
    RUNTIME_PROVIDER: "container",
    CODEX_BIN: "codex",
    RUNTIME_INSTANCE_ID: "airlock-modelark-demo",
  };
}

async function requestJson(baseUrl, pathname, options, fetchImpl) {
  const response = await fetchImpl(baseUrl + pathname, {
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${pathname}`);
  return response.json();
}

export async function seedLiveModelArkDemo(baseUrl, fetchImpl = fetch) {
  const { agents } = await requestJson(baseUrl, "/api/agents", {}, fetchImpl);
  const matches = agents.filter((agent) => agent.name === liveModelArkAgentName);
  if (matches.length > 1) {
    throw new Error("The managed demo contains duplicate Live ModelArk Proof Agents");
  }
  let agent = matches[0];
  if (!agent) {
    ({ agent } = await requestJson(
      baseUrl,
      "/api/agents",
      {
        method: "POST",
        body: JSON.stringify({
          name: liveModelArkAgentName,
          description: "Provider-backed inference, isolated Candidate, validated Promotion",
          instructions:
            "Work only in isolated Candidate State. Create the requested proof artifact, run the required verification, and report the observed result.",
        }),
      },
      fetchImpl,
    ));
    await requestJson(
      baseUrl,
      `/api/agents/${agent.id}/outcome-contract`,
      {
        method: "PUT",
        body: JSON.stringify(liveModelArkContract),
      },
      fetchImpl,
    );
    return agent;
  }
  if (
    JSON.stringify(comparableContract(agent.outcomeContract)) !==
    JSON.stringify(liveModelArkContract)
  ) {
    throw new Error(
      "The Live ModelArk Proof Outcome Contract changed. Restart with --reset for the guaranteed judge path.",
    );
  }
  return agent;
}
