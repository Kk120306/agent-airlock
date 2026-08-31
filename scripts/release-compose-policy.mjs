function executableLines(source) {
  if (typeof source !== "string") return [];
  return source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function hasLine(lines, expected) {
  return lines.filter((line) => line === expected).length === 1;
}

function hasExactSequence(lines, expected) {
  let matches = 0;
  for (let index = 0; index <= lines.length - expected.length; index += 1) {
    if (
      expected.every((line, offset) => lines[index + offset] === line)
    ) {
      matches += 1;
    }
  }
  return matches === 1;
}

function indentation(line) {
  return line.match(/^ */u)?.[0].length ?? 0;
}

function significantYamlLine(line) {
  const trimmed = line.trim();
  return trimmed.length > 0 && !trimmed.startsWith("#");
}

function yamlBlock(lines, indent, key) {
  const prefix = `${" ".repeat(indent)}${key}:`;
  const starts = lines
    .map((line, index) => (line === prefix ? index : -1))
    .filter((index) => index >= 0);
  if (starts.length !== 1) return null;
  const start = starts[0];
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (
      significantYamlLine(lines[index]) &&
      indentation(lines[index]) <= indent
    ) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

function directYamlLines(block, indent) {
  if (!block) return [];
  return block
    .filter(
      (line) => significantYamlLine(line) && indentation(line) === indent,
    )
    .map((line) => line.trim());
}

function exactLaunchpadComposePolicy(source) {
  if (typeof source !== "string" || source.includes("\t")) return false;
  const lines = source.split(/\r?\n/u);
  if (
    JSON.stringify(directYamlLines(lines, 0)) !==
    JSON.stringify(["services:"])
  ) {
    return false;
  }
  const services = yamlBlock(lines, 0, "services");
  if (
    JSON.stringify(directYamlLines(services, 2)) !==
    JSON.stringify(["launchpad:"])
  ) {
    return false;
  }
  const launchpad = yamlBlock(services ?? [], 2, "launchpad");
  if (!launchpad) return false;
  const service = directYamlLines(launchpad, 4);
  const envFile = directYamlLines(yamlBlock(launchpad, 4, "env_file"), 6);
  const labels = directYamlLines(yamlBlock(launchpad, 4, "labels"), 6);
  const environment = directYamlLines(
    yamlBlock(launchpad, 4, "environment"),
    6,
  );
  const ports = directYamlLines(yamlBlock(launchpad, 4, "ports"), 6);
  const volumes = directYamlLines(yamlBlock(launchpad, 4, "volumes"), 6);
  const temporaryFilesystems = directYamlLines(
    yamlBlock(launchpad, 4, "tmpfs"),
    6,
  );
  const securityOptions = directYamlLines(
    yamlBlock(launchpad, 4, "security_opt"),
    6,
  );
  const droppedCapabilities = directYamlLines(
    yamlBlock(launchpad, 4, "cap_drop"),
    6,
  );
  const build = directYamlLines(yamlBlock(launchpad, 4, "build"), 6);
  const buildArguments = directYamlLines(
    yamlBlock(yamlBlock(launchpad, 4, "build") ?? [], 6, "args"),
    8,
  );
  return (
    JSON.stringify(service) ===
      JSON.stringify([
        "build:",
        "image: ${LAUNCHPAD_IMAGE:-volc-agent-launchpad:local}",
        "labels:",
        "user: ${CONTAINER_USER:-1000:1000}",
        "restart: unless-stopped",
        "env_file:",
        "environment:",
        "ports:",
        "volumes:",
        "read_only: true",
        "tmpfs:",
        "init: true",
        "security_opt:",
        "cap_drop:",
        "pids_limit: 512",
        "mem_limit: 4g",
        "cpus: 2",
      ]) &&
    hasLine(build, "context: .") &&
    hasLine(build, "dockerfile: Dockerfile") &&
    hasLine(
      buildArguments,
      "NODE_IMAGE: ${CONTAINER_RUNTIME_BASE_IMAGE:-node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5}",
    ) &&
    hasLine(
      buildArguments,
      "DEBIAN_MIRROR: ${CONTAINER_APT_MIRROR:-}",
    ) &&
    hasLine(
      buildArguments,
      "DEBIAN_SECURITY_MIRROR: ${CONTAINER_APT_SECURITY_MIRROR:-}",
    ) &&
    buildArguments.length === 3 &&
    hasLine(envFile, "- ${LAUNCHPAD_ENV_FILE:-.env}") &&
    envFile.length === 1 &&
    hasLine(
      labels,
      "io.codejam.production-gate-owner: ${PRODUCTION_GATE_OWNER:-local}",
    ) &&
    labels.length === 1 &&
    hasLine(environment, "NODE_ENV: production") &&
    hasLine(environment, "HOST: 0.0.0.0") &&
    hasLine(environment, "PORT: 3000") &&
    hasLine(environment, "APP_DATA_DIR: /app/data") &&
    hasLine(environment, "AGENT_WORKSPACE_ROOT: /app/workspaces") &&
    hasLine(environment, "CODEX_HOME: /app/codex-home") &&
    hasLine(environment, "HOME: /app/codex-home") &&
    hasLine(
      environment,
      "CODEX_SANDBOX_MODE: workspace-write",
    ) &&
    environment.length === 8 &&
    hasLine(
      ports,
      '- "${PUBLIC_BIND_ADDRESS:-127.0.0.1}:${PUBLIC_PORT:-3000}:3000"',
    ) &&
    ports.length === 1 &&
    hasLine(volumes, "- ${LAUNCHPAD_DATA_DIR:-./data}:/app/data") &&
    hasLine(
      volumes,
      "- ${LAUNCHPAD_WORKSPACE_DIR:-./workspaces}:/app/workspaces",
    ) &&
    hasLine(
      volumes,
      "- ${LAUNCHPAD_CODEX_HOME_DIR:-./codex-home}:/app/codex-home",
    ) &&
    volumes.length === 3 &&
    hasLine(
      temporaryFilesystems,
      "- /tmp:rw,noexec,nosuid,nodev,mode=1777",
    ) &&
    temporaryFilesystems.length === 1 &&
    hasLine(securityOptions, "- no-new-privileges:true") &&
    securityOptions.length === 1 &&
    hasLine(droppedCapabilities, "- ALL") &&
    droppedCapabilities.length === 1
  );
}

function absentOrEmpty(value) {
  return value === undefined || value === null ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
}

function approvedResolvedBindOptions(value) {
  return absentOrEmpty(value) ||
    (value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      JSON.stringify(Object.keys(value).sort()) ===
        JSON.stringify(["create_host_path"]) &&
      value.create_host_path === true);
}

export function approvedResolvedLaunchpadComposeConfig(config, expected = {}) {
  const serviceNames = Object.keys(config?.services ?? {}).sort();
  const service = config?.services?.launchpad;
  const serviceKeys = Object.keys(service ?? {}).sort();
  const buildArguments = service?.build?.args;
  const expectedMounts = new Map([
    ["/app/data", expected.dataDirectory],
    ["/app/workspaces", expected.workspaceDirectory],
    ["/app/codex-home", expected.codexHomeDirectory],
  ]);
  const volumes = Array.isArray(service?.volumes) ? service.volumes : [];
  const ports = Array.isArray(service?.ports) ? service.ports : [];
  const expectedEnvironment = {
    AGENT_WORKSPACE_ROOT: "/app/workspaces",
    AIRLOCK_DEMO_MODE: "false",
    AIRLOCK_PROTOCOL_FIXTURE_MODE: "true",
    APP_AUTH_TOKEN: "phase11-container-verification-token",
    APP_DATA_DIR: "/app/data",
    ARK_API_KEY: "deterministic-protocol-fixture",
    ARK_BASE_URL: "http://127.0.0.1:43991/v1",
    ARK_MODEL: "protocol-fixture",
    CODEX_BIN: "codex",
    CODEX_HOME: "/app/codex-home",
    CODEX_SANDBOX_MODE: "workspace-write",
    HOME: "/app/codex-home",
    HOST: "0.0.0.0",
    NODE_ENV: "production",
    PORT: "3000",
    RUNTIME_PROVIDER: "local-process",
  };
  return (
    JSON.stringify(Object.keys(config ?? {}).sort()) ===
      JSON.stringify(["name", "networks", "services"]) &&
    config?.name === expected.projectName &&
    JSON.stringify(Object.keys(config?.networks ?? {}).sort()) ===
      JSON.stringify(["default"]) &&
    JSON.stringify(config?.networks?.default) ===
      JSON.stringify({ name: `${expected.projectName}_default`, ipam: {} }) &&
    JSON.stringify(serviceNames) === JSON.stringify(["launchpad"]) &&
    JSON.stringify(serviceKeys) ===
      JSON.stringify([
        "build",
        "cap_drop",
        "command",
        "cpus",
        "entrypoint",
        "environment",
        "image",
        "init",
        "labels",
        "mem_limit",
        "networks",
        "pids_limit",
        "ports",
        "read_only",
        "restart",
        "security_opt",
        "tmpfs",
        "user",
        "volumes",
      ]) &&
    service?.image === expected.image &&
    JSON.stringify(service?.labels) ===
      JSON.stringify({
        "io.codejam.production-gate-owner": expected.owner,
      }) &&
    service?.user === expected.user &&
    service?.build?.context === expected.projectRoot &&
    service?.build?.dockerfile === "Dockerfile" &&
    JSON.stringify(Object.keys(buildArguments ?? {}).sort()) ===
      JSON.stringify([
        "DEBIAN_MIRROR",
        "DEBIAN_SECURITY_MIRROR",
        "NODE_IMAGE",
      ]) &&
    buildArguments?.NODE_IMAGE ===
      "node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5" &&
    buildArguments?.DEBIAN_MIRROR === "" &&
    buildArguments?.DEBIAN_SECURITY_MIRROR === "" &&
    (service?.command === undefined || service.command === null) &&
    (service?.entrypoint === undefined || service.entrypoint === null) &&
    JSON.stringify(service?.environment) ===
      JSON.stringify(expectedEnvironment) &&
    service?.restart === "unless-stopped" &&
    service?.read_only === true &&
    JSON.stringify(service?.tmpfs) ===
      JSON.stringify(["/tmp:rw,noexec,nosuid,nodev,mode=1777"]) &&
    service?.init === true &&
    service?.pids_limit === 512 &&
    service?.mem_limit === "4294967296" &&
    service?.cpus === 2 &&
    JSON.stringify(service?.cap_drop) === JSON.stringify(["ALL"]) &&
    JSON.stringify(service?.security_opt) ===
      JSON.stringify(["no-new-privileges:true"]) &&
    JSON.stringify(service?.networks) === JSON.stringify({ default: null }) &&
    volumes.length === 3 &&
    volumes.every(
      (volume) =>
        JSON.stringify(Object.keys(volume).sort()) ===
          JSON.stringify(["bind", "source", "target", "type"]) &&
        volume?.type === "bind" &&
        approvedResolvedBindOptions(volume?.bind) &&
        expectedMounts.get(volume.target) === volume.source,
    ) &&
    ports.length === 1 &&
    ports[0]?.target === 3000 &&
    ports[0]?.host_ip === "127.0.0.1" &&
    String(ports[0]?.published) === "0" &&
    ports[0]?.mode === "ingress" &&
    ports[0]?.protocol === "tcp" &&
    JSON.stringify(Object.keys(ports[0]).sort()) ===
      JSON.stringify(["host_ip", "mode", "protocol", "published", "target"])
  );
}

function exactTerraformRuntimeEnvironment(source) {
  if (typeof source !== "string") return false;
  const lines = source.split(/\r?\n/u);
  const starts = lines
    .map((line, index) =>
      line === '  runtime_env = join("\\n", [' ? index : -1,
    )
    .filter((index) => index >= 0);
  if (starts.length !== 1) return false;
  const start = starts[0];
  const localsStart = lines.slice(0, start + 1).lastIndexOf("locals {");
  if (localsStart < 0) return false;
  const localsEnd = lines.findIndex(
    (line, index) => index > localsStart && line === "}",
  );
  if (localsEnd < start) return false;
  const ends = lines
    .map((line, index) => (index > start && line === "  ])" ? index : -1))
    .filter((index) => index > start && index < localsEnd);
  if (ends.length !== 1) return false;
  const runtimeEntries = lines
    .slice(start + 1, ends[0])
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .map((line) => line.trim());
  return (
    hasLine(runtimeEntries, '"PUBLIC_BIND_ADDRESS=0.0.0.0",') &&
    runtimeEntries.filter((line) =>
      line.startsWith('"PUBLIC_BIND_ADDRESS='),
    ).length === 1
  );
}

export function approvedLocalComposeIdentityPolicy({
  bootstrapSource,
  composeSource,
  deploymentDocumentSource,
  deploymentSource,
  productGateSource,
  terraformSource,
} = {}) {
  const bootstrap = executableLines(bootstrapSource);
  const deployment = executableLines(deploymentSource);
  const deploymentDocument = executableLines(deploymentDocumentSource);
  const productGate = executableLines(productGateSource);
  return (
    exactLaunchpadComposePolicy(composeSource) &&
    hasLine(bootstrap, "umask 077") &&
    hasExactSequence(bootstrap, [
      'if [[ -L .env ]]; then',
      'echo "Refusing to use a symlinked .env file." >&2',
      "exit 1",
      "fi",
    ]) &&
    hasLine(bootstrap, "chmod 600 .env") &&
    hasExactSequence(bootstrap, [
      'if [[ "$env_mode" != "600" ]]; then',
      'echo ".env must have mode 600; run: chmod 600 .env" >&2',
      "exit 1",
      "fi",
    ]) &&
    hasLine(
      bootstrap,
      'echo "  1. Fill APP_AUTH_TOKEN, ARK_API_KEY, and ARK_MODEL in .env"',
    ) &&
    hasLine(bootstrap, 'host_uid="$(id -u)"') &&
    hasLine(bootstrap, 'host_gid="$(id -g)"') &&
    hasExactSequence(bootstrap, [
      'if [[ "$host_uid" == "0" || "$host_gid" == "0" ]]; then',
      'echo "Local Compose bootstrap requires a non-root host UID and GID." >&2',
      "exit 1",
      "fi",
    ]) &&
    hasLine(
      bootstrap,
      "if ! grep -Eq '^[[:space:]]*CONTAINER_USER[[:space:]]*=' .env; then",
    ) &&
    hasLine(
      bootstrap,
      "printf '\\nCONTAINER_USER=%s:%s\\n' \"$host_uid\" \"$host_gid\" >> .env",
    ) &&
    hasLine(
      bootstrap,
      'if [[ ! "$container_user" =~ ^[1-9][0-9]*:[1-9][0-9]*$ ]]; then',
    ) &&
    hasLine(productGate, 'HOST_UID="$(id -u)"') &&
    hasLine(productGate, 'HOST_GID="$(id -g)"') &&
    hasLine(
      productGate,
      'if [ "$HOST_UID" = "0" ] || [ "$HOST_GID" = "0" ]; then',
    ) &&
    hasLine(productGate, 'export CONTAINER_USER="$HOST_UID:$HOST_GID"') &&
    hasLine(productGate, "export CODEX_SANDBOX_MODE=workspace-write") &&
    hasLine(
      productGate,
      "export CONTAINER_RUNTIME_BASE_IMAGE=node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5",
    ) &&
    hasLine(productGate, 'export CONTAINER_APT_MIRROR=""') &&
    hasLine(productGate, 'export CONTAINER_APT_SECURITY_MIRROR=""') &&
    hasLine(productGate, 'RUNTIME_GID="${RUNTIME_ID#*:}"') &&
    hasLine(
      productGate,
      'if [ "$RUNTIME_UID" = "0" ] || [ "$RUNTIME_UID" = "-1" ] || [ "$RUNTIME_GID" = "0" ] || [ "$RUNTIME_GID" = "-1" ]; then',
    ) &&
    hasLine(
      productGate,
      'SESSION_BASE="$PROJECT_ROOT/.local/production-image-gate"',
    ) &&
    hasLine(
      productGate,
      "product_compose up --detach --no-build launchpad >/dev/null",
    ) &&
    hasLine(productGate, "assert_compose_service_contract") &&
    hasExactSequence(deployment, [
      'if [[ "$public_bind_address" != "0.0.0.0" ]]; then',
      'echo "Public ECS deployment requires PUBLIC_BIND_ADDRESS=0.0.0.0 in $env_file." >&2',
      'echo "Restrict ingress, use a strong APP_AUTH_TOKEN, and add TLS before an untrusted network." >&2',
      "exit 1",
      "fi",
    ]) &&
    hasLine(deployment, 'export PUBLIC_BIND_ADDRESS="$public_bind_address"') &&
    hasExactSequence(deployment, [
      'if [[ -L "$env_file" ]]; then',
      'echo "Refusing to use a symlinked production environment file." >&2',
      "exit 1",
      "fi",
    ]) &&
    hasExactSequence(deployment, [
      'if [[ "$env_mode" != "600" ]]; then',
      'echo "$env_file must have mode 600; run: chmod 600 $env_file" >&2',
      "exit 1",
      "fi",
    ]) &&
    hasLine(deployment, "export CONTAINER_USER=1000:1000") &&
    hasExactSequence(deployment, [
      'if [[ "$requested_sandbox_mode" != "workspace-write" ]]; then',
      'echo "Public ECS deployment requires CODEX_SANDBOX_MODE=workspace-write." >&2',
      'echo "The application container must never expose mutable Canonical State to an unrestricted Agent child." >&2',
      "exit 1",
      "fi",
    ]) &&
    hasExactSequence(deployment, [
      'docker compose --env-file "$env_file" build launchpad',
      'if ! docker compose --env-file "$env_file" run --rm --no-deps launchpad \\',
      "codex sandbox linux --full-auto -- true >/dev/null 2>&1; then",
      'echo "Codex Landlock is unavailable on this Linux kernel/container runtime." >&2',
      'echo "Refusing to start because local-process execution cannot safely isolate mutable Canonical State." >&2',
      "exit 1",
      "fi",
      'docker compose --env-file "$env_file" up -d --no-build launchpad',
    ]) &&
    exactTerraformRuntimeEnvironment(terraformSource) &&
    hasLine(deploymentDocument, "PUBLIC_BIND_ADDRESS=0.0.0.0") &&
    !productGate.some((line) => /(^|\s)chown(\s|$)/u.test(line))
  );
}

async function assertResolvedConfigFromStandardInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.byteLength;
    if (bytes > 2 * 1024 * 1024) {
      throw new Error("Resolved Compose config exceeded its policy boundary");
    }
    chunks.push(chunk);
  }
  const config = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const approved = approvedResolvedLaunchpadComposeConfig(config, {
    image: process.env.EXPECTED_IMAGE,
    user: process.env.EXPECTED_USER,
    projectRoot: process.env.EXPECTED_PROJECT_ROOT,
    dataDirectory: process.env.EXPECTED_DATA,
    workspaceDirectory: process.env.EXPECTED_WORKSPACES,
    codexHomeDirectory: process.env.EXPECTED_CODEX_HOME,
    projectName: process.env.EXPECTED_COMPOSE_PROJECT,
    owner: process.env.EXPECTED_OWNER,
  });
  if (!approved) {
    throw new Error(
      "Resolved Compose service contradicts the production gate contract",
    );
  }
}

async function assertRepositorySourcePolicy() {
  const projectRoot = path.resolve(".");
  const readSource = (relativePath) =>
    readFile(path.join(projectRoot, relativePath), "utf8");
  const approved = approvedLocalComposeIdentityPolicy({
    bootstrapSource: await readSource("scripts/bootstrap-local.sh"),
    composeSource: await readSource("docker-compose.yml"),
    deploymentDocumentSource: await readSource("docs/DEPLOYMENT.md"),
    deploymentSource: await readSource("scripts/deploy-existing-ecs.sh"),
    productGateSource: await readSource(
      "scripts/check-phase-eleven-docker.sh",
    ),
    terraformSource: await readSource("deploy/volcengine/main.tf"),
  });
  if (!approved) {
    throw new Error(
      "Repository Compose and deployment sources contradict the production gate contract",
    );
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    throw new Error(
      "Usage: node scripts/release-compose-policy.mjs --assert-source|--assert-resolved",
    );
  }
  if (process.argv[2] === "--assert-source") {
    await assertRepositorySourcePolicy();
  } else if (process.argv[2] === "--assert-resolved") {
    await assertResolvedConfigFromStandardInput();
  } else {
    throw new Error(
      "Usage: node scripts/release-compose-policy.mjs --assert-source|--assert-resolved",
    );
  }
}
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
