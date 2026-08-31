import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  approvedLocalComposeIdentityPolicy,
  approvedResolvedLaunchpadComposeConfig,
} from "./release-compose-policy.mjs";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const baseline = {
  bootstrapSource: await readFile(
    path.join(projectRoot, "scripts/bootstrap-local.sh"),
    "utf8",
  ),
  composeSource: await readFile(
    path.join(projectRoot, "docker-compose.yml"),
    "utf8",
  ),
  deploymentDocumentSource: await readFile(
    path.join(projectRoot, "docs/DEPLOYMENT.md"),
    "utf8",
  ),
  deploymentSource: await readFile(
    path.join(projectRoot, "scripts/deploy-existing-ecs.sh"),
    "utf8",
  ),
  productGateSource: await readFile(
    path.join(projectRoot, "scripts/check-phase-eleven-docker.sh"),
    "utf8",
  ),
  terraformSource: await readFile(
    path.join(projectRoot, "deploy/volcengine/main.tf"),
    "utf8",
  ),
};

test("local Compose identity policy binds bootstrap, Compose, and product gate", () => {
  assert.equal(approvedLocalComposeIdentityPolicy(baseline), true);
});

test("local Compose identity policy rejects removed or commented controls", async (context) => {
  for (const [name, field, marker] of [
    [
      "Compose user mapping removed",
      "composeSource",
      "    user: ${CONTAINER_USER:-1000:1000}",
    ],
    [
      "Compose loopback publish default removed",
      "composeSource",
      '      - "${PUBLIC_BIND_ADDRESS:-127.0.0.1}:${PUBLIC_PORT:-3000}:3000"',
    ],
    [
      "Compose Canonical workspace mount environment removed",
      "composeSource",
      "      AGENT_WORKSPACE_ROOT: /app/workspaces",
    ],
    [
      "Compose restart policy removed",
      "composeSource",
      "    restart: unless-stopped",
    ],
    [
      "Compose process limit removed",
      "composeSource",
      "    pids_limit: 512",
    ],
    [
      "bootstrap host identity capture removed",
      "bootstrapSource",
      'host_uid="$(id -u)"',
    ],
    [
      "bootstrap root rejection removed",
      "bootstrapSource",
      'if [[ "$host_uid" == "0" || "$host_gid" == "0" ]]; then',
    ],
    [
      "product gate host mapping removed",
      "productGateSource",
      'export CONTAINER_USER="$HOST_UID:$HOST_GID"',
    ],
    [
      "product Compose launch removed",
      "productGateSource",
      "  product_compose up --detach --no-build launchpad >/dev/null",
    ],
    [
      "ECS public bind validation removed",
      "deploymentSource",
      'if [[ "$public_bind_address" != "0.0.0.0" ]]; then',
    ],
    [
      "ECS sandbox preflight removed",
      "deploymentSource",
      'if ! docker compose --env-file "$env_file" run --rm --no-deps launchpad \\',
    ],
    [
      "ECS fixed non-root identity removed",
      "deploymentSource",
      "export CONTAINER_USER=1000:1000",
    ],
    [
      "Terraform public bind override removed",
      "terraformSource",
      '    "PUBLIC_BIND_ADDRESS=0.0.0.0",',
    ],
    [
      "deployment public bind documentation removed",
      "deploymentDocumentSource",
      "PUBLIC_BIND_ADDRESS=0.0.0.0",
    ],
  ]) {
    await context.test(name, () => {
      const removed = {
        ...baseline,
        [field]: baseline[field].replace(marker, `# ${marker.trim()}`),
      };
      assert.equal(approvedLocalComposeIdentityPolicy(removed), false);
    });
  }
});

test("local Compose identity policy rejects a service command override", () => {
  assert.equal(
    approvedLocalComposeIdentityPolicy({
      ...baseline,
      composeSource: baseline.composeSource.replace(
        "    restart: unless-stopped",
        "    command: false\n    restart: unless-stopped",
      ),
    }),
    false,
  );
});

test("local Compose identity policy rejects added privilege and mount channels", async (context) => {
  for (const [name, addition] of [
    ["privileged", "    privileged: true"],
    ["capability", "    cap_add: [SYS_ADMIN]"],
    ["host pid", "    pid: host"],
    ["host ipc", "    ipc: host"],
    ["host network", "    network_mode: host"],
    ["volumes from", "    volumes_from: [escape]"],
    ["service secret", "    secrets: [escape]"],
    ["service config", "    configs: [escape]"],
    ["extra host", "    extra_hosts: [escape:127.0.0.1]"],
    ["DNS override", "    dns: [8.8.8.8]"],
    ["service link", "    links: [escape]"],
  ]) {
    await context.test(name, () => {
      assert.equal(
        approvedLocalComposeIdentityPolicy({
          ...baseline,
          composeSource: baseline.composeSource.replace(
            "    restart: unless-stopped",
            `    restart: unless-stopped\n${addition}`,
          ),
        }),
        false,
      );
    });
  }
});

test("local Compose identity policy rejects extra environment variables", () => {
  assert.equal(
    approvedLocalComposeIdentityPolicy({
      ...baseline,
      composeSource: baseline.composeSource.replace(
        "      NODE_ENV: production",
        "      NODE_ENV: production\n      AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY:-decoy}",
      ),
    }),
    false,
  );
});

test("local Compose identity policy rejects a public host publish default", () => {
  assert.equal(
    approvedLocalComposeIdentityPolicy({
      ...baseline,
      composeSource: baseline.composeSource.replace(
        "${PUBLIC_BIND_ADDRESS:-127.0.0.1}",
        "${PUBLIC_BIND_ADDRESS:-0.0.0.0}",
      ),
    }),
    false,
  );
});

test("local Compose identity policy rejects safe markers relocated to a decoy extension", () => {
  const unsafeLaunchpad = baseline.composeSource
    .replace(
      "    user: ${CONTAINER_USER:-1000:1000}",
      "    user: 0:0",
    )
    .replace(
      '${PUBLIC_BIND_ADDRESS:-127.0.0.1}',
      '${PUBLIC_BIND_ADDRESS:-0.0.0.0}',
    );
  const decoy = [
    "",
    "x-policy-decoy:",
    "  user: ${CONTAINER_USER:-1000:1000}",
    '  port: "${PUBLIC_BIND_ADDRESS:-127.0.0.1}:${PUBLIC_PORT:-3000}:3000"',
    "",
  ].join("\n");
  assert.equal(
    approvedLocalComposeIdentityPolicy({
      ...baseline,
      composeSource: unsafeLaunchpad + decoy,
    }),
    false,
  );
});

test("local Compose identity policy rejects a top-level external default network", () => {
  assert.equal(
    approvedLocalComposeIdentityPolicy({
      ...baseline,
      composeSource: `${baseline.composeSource}\nnetworks:\n  default:\n    external: true\n    name: ambient-host-network\n`,
    }),
    false,
  );
});

test("local Compose identity policy binds the Terraform runtime environment", () => {
  const unsafeRuntime = baseline.terraformSource.replace(
    '    "PUBLIC_BIND_ADDRESS=0.0.0.0",',
    '    "PUBLIC_BIND_ADDRESS=127.0.0.1",',
  );
  const decoy = [
    "",
    "locals {",
    '  policy_decoy = "PUBLIC_BIND_ADDRESS=0.0.0.0"',
    "}",
    "",
  ].join("\n");
  assert.equal(
    approvedLocalComposeIdentityPolicy({
      ...baseline,
      terraformSource: unsafeRuntime + decoy,
    }),
    false,
  );
});

test("local Compose identity policy rejects a duplicate Terraform public bind", () => {
  assert.equal(
    approvedLocalComposeIdentityPolicy({
      ...baseline,
      terraformSource: baseline.terraformSource.replace(
        '    "PUBLIC_BIND_ADDRESS=0.0.0.0",',
        '    "PUBLIC_BIND_ADDRESS=0.0.0.0",\n    "PUBLIC_BIND_ADDRESS=127.0.0.1",',
      ),
    }),
    false,
  );
});

test("local Compose identity policy binds fail-closed guard bodies", async (context) => {
  for (const [name, field, marker] of [
    [
      "bootstrap root rejection",
      "bootstrapSource",
      'echo "Local Compose bootstrap requires a non-root host UID and GID." >&2\n  exit 1',
    ],
    [
      "deployment public bind rejection",
      "deploymentSource",
      'echo "Restrict ingress, use a strong APP_AUTH_TOKEN, and add TLS before an untrusted network." >&2\n  exit 1',
    ],
    [
      "deployment sandbox rejection",
      "deploymentSource",
      'echo "The application container must never expose mutable Canonical State to an unrestricted Agent child." >&2\n  exit 1',
    ],
    [
      "deployment environment mode rejection",
      "deploymentSource",
      'echo "$env_file must have mode 600; run: chmod 600 $env_file" >&2\n  exit 1',
    ],
  ]) {
    await context.test(name, () => {
      assert.equal(
        approvedLocalComposeIdentityPolicy({
          ...baseline,
          [field]: baseline[field].replace(marker, marker.replace("exit 1", ":")),
        }),
        false,
      );
    });
  }
});

test("local Compose identity policy requires sandbox preflight before service start", () => {
  const preflight = `docker compose --env-file "$env_file" build launchpad
if ! docker compose --env-file "$env_file" run --rm --no-deps launchpad \\
  codex sandbox linux --full-auto -- true >/dev/null 2>&1; then`;
  const startedFirst = `docker compose --env-file "$env_file" build launchpad
docker compose --env-file "$env_file" up -d --no-build launchpad
if ! docker compose --env-file "$env_file" run --rm --no-deps launchpad \\
  codex sandbox linux --full-auto -- true >/dev/null 2>&1; then`;
  assert.equal(
    approvedLocalComposeIdentityPolicy({
      ...baseline,
      deploymentSource: baseline.deploymentSource.replace(
        preflight,
        startedFirst,
      ),
    }),
    false,
  );
});

test("local Compose identity policy requires the exact Dockerfile build", async (context) => {
  for (const [name, marker, replacement] of [
    ["context", "      context: .", "      context: ./decoy"],
    ["Dockerfile", "      dockerfile: Dockerfile", "      dockerfile: Dockerfile.other"],
  ]) {
    await context.test(name, () => {
      assert.equal(
        approvedLocalComposeIdentityPolicy({
          ...baseline,
          composeSource: baseline.composeSource.replace(marker, replacement),
        }),
        false,
      );
    });
  }
});

test("local Compose identity policy rejects a second shipped service", () => {
  assert.equal(
    approvedLocalComposeIdentityPolicy({
      ...baseline,
      composeSource: `${baseline.composeSource}\n  escape:\n    image: alpine\n    network_mode: host\n`,
    }),
    false,
  );
});

function resolvedFixture() {
  return {
    name: "proof-project",
    networks: {
      default: { name: "proof-project_default", ipam: {} },
    },
    services: {
      launchpad: {
        build: {
          context: "/repo",
          dockerfile: "Dockerfile",
          args: {
            DEBIAN_MIRROR: "",
            DEBIAN_SECURITY_MIRROR: "",
            NODE_IMAGE:
              "node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5",
          },
        },
        cap_drop: ["ALL"],
        cpus: 2,
        command: null,
        entrypoint: null,
        environment: {
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
        },
        image: "proof:image",
        init: true,
        labels: {
          "io.codejam.production-gate-owner": "proof-owner",
        },
        mem_limit: "4294967296",
        pids_limit: 512,
        ports: [{
          mode: "ingress",
          host_ip: "127.0.0.1",
          target: 3000,
          published: "0",
          protocol: "tcp",
        }],
        restart: "unless-stopped",
        read_only: true,
        security_opt: ["no-new-privileges:true"],
        tmpfs: ["/tmp:rw,noexec,nosuid,nodev,mode=1777"],
        user: "1234:5678",
        networks: { default: null },
        volumes: [
          {
            type: "bind",
            source: "/proof/data",
            target: "/app/data",
            bind: {},
          },
          {
            type: "bind",
            source: "/proof/workspaces",
            target: "/app/workspaces",
            bind: {},
          },
          {
            type: "bind",
            source: "/proof/codex-home",
            target: "/app/codex-home",
            bind: {},
          },
        ],
      },
    },
  };
}

const resolvedExpected = {
  image: "proof:image",
  user: "1234:5678",
  projectRoot: "/repo",
  dataDirectory: "/proof/data",
  workspaceDirectory: "/proof/workspaces",
  codexHomeDirectory: "/proof/codex-home",
  projectName: "proof-project",
  owner: "proof-owner",
};

test("resolved Compose policy accepts the exact isolated launchpad service", () => {
  assert.equal(
    approvedResolvedLaunchpadComposeConfig(resolvedFixture(), resolvedExpected),
    true,
  );
});

test("resolved Compose policy accepts explicit short-syntax bind semantics", () => {
  const config = resolvedFixture();
  for (const volume of config.services.launchpad.volumes) {
    volume.bind = { create_host_path: true };
  }
  assert.equal(
    approvedResolvedLaunchpadComposeConfig(config, resolvedExpected),
    true,
  );
});

test("resolved Compose policy rejects privilege and identity mutations", async (context) => {
  const mutations = [
    ["hostile ambient sandbox", (service) => (service.environment.CODEX_SANDBOX_MODE = "danger-full-access")],
    ["privileged", (service) => (service.privileged = true)],
    ["added capability", (service) => (service.cap_add = ["SYS_ADMIN"])],
    ["host network", (service) => (service.network_mode = "host")],
    ["host pid", (service) => (service.pid = "host")],
    ["device", (service) => (service.devices = ["/dev/kvm:/dev/kvm"])],
    ["group", (service) => (service.group_add = ["docker"])],
    ["unconfined seccomp", (service) => service.security_opt.push("seccomp=unconfined")],
    ["extra capability drop drift", (service) => service.cap_drop.push("NET_RAW")],
    ["wrong build context", (service) => (service.build.context = "/tmp/decoy")],
    ["wrong Dockerfile", (service) => (service.build.dockerfile = "Dockerfile.other")],
    ["unpinned base image", (service) => (service.build.args.NODE_IMAGE = "node:22-bookworm-slim")],
    ["writable root", (service) => (service.read_only = false)],
    ["executable temporary filesystem", (service) => (service.tmpfs = ["/tmp:rw,exec,mode=1777"])],
    ["ambient AWS credential", (service) => (service.environment.AWS_SECRET_ACCESS_KEY = "escape")],
    ["volumes from", (service) => (service.volumes_from = ["escape"])],
    ["service secret", (service) => (service.secrets = ["escape"])],
    ["service config", (service) => (service.configs = ["escape"])],
    ["extra network", (service) => (service.networks.escape = null)],
    ["extra host", (service) => (service.extra_hosts = ["escape=127.0.0.1"])],
    ["DNS override", (service) => (service.dns = ["8.8.8.8"])],
    ["service link", (service) => (service.links = ["escape"])],
    ["volume bind options", (service) => (service.volumes[0].bind = { propagation: "rshared" })],
    ["disabled short-syntax bind", (service) => (service.volumes[0].bind = { create_host_path: false })],
  ];
  for (const [name, mutate] of mutations) {
    await context.test(name, () => {
      const config = resolvedFixture();
      mutate(config.services.launchpad);
      assert.equal(
        approvedResolvedLaunchpadComposeConfig(config, resolvedExpected),
        false,
      );
    });
  }
});

test("resolved Compose policy rejects an additional service", () => {
  const config = resolvedFixture();
  config.services.escape = { image: "alpine", network_mode: "host" };
  assert.equal(
    approvedResolvedLaunchpadComposeConfig(config, resolvedExpected),
    false,
  );
});

test("resolved Compose policy rejects external or renamed default networks", async (context) => {
  for (const [name, mutate] of [
    ["external", (config) => (config.networks.default.external = true)],
    ["renamed", (config) => (config.networks.default.name = "ambient-host-network")],
    ["driver options", (config) => (config.networks.default.driver_opts = { escape: "true" })],
    ["extra top-level key", (config) => (config.secrets = { escape: { external: true } })],
  ]) {
    await context.test(name, () => {
      const config = resolvedFixture();
      mutate(config);
      assert.equal(
        approvedResolvedLaunchpadComposeConfig(config, resolvedExpected),
        false,
      );
    });
  }
});

async function fakeId(binDirectory, uid, gid) {
  const executable = path.join(binDirectory, "id");
  await writeFile(
    executable,
    `#!/bin/sh\ncase "$1" in\n  -u) echo ${uid} ;;\n  -g) echo ${gid} ;;\n  *) exit 2 ;;\nesac\n`,
    "utf8",
  );
  await chmod(executable, 0o755);
}

async function bootstrapFixture({ envSource, uid = 1234, gid = 5678 }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "airlock-bootstrap-test-"));
  const scripts = path.join(root, "scripts");
  const bin = path.join(root, "bin");
  await mkdir(scripts);
  await mkdir(bin);
  await cp(path.join(projectRoot, "scripts/bootstrap-local.sh"), path.join(scripts, "bootstrap-local.sh"));
  await writeFile(path.join(root, ".env.example"), envSource, "utf8");
  await fakeId(bin, uid, gid);
  const run = () =>
    execFileAsync("bash", [path.join(scripts, "bootstrap-local.sh")], {
      cwd: root,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  return { root, run };
}

test("bootstrap captures a non-root host identity and preserves an override", async () => {
  const captured = await bootstrapFixture({
    envSource: "# CONTAINER_USER=1000:1000\n",
  });
  try {
    const result = await captured.run();
    assert.match(
      await readFile(path.join(captured.root, ".env"), "utf8"),
      /^CONTAINER_USER=1234:5678$/mu,
    );
    assert.equal((await stat(path.join(captured.root, ".env"))).mode & 0o777, 0o600);
    assert.match(result.stdout, /APP_AUTH_TOKEN, ARK_API_KEY, and ARK_MODEL/u);
  } finally {
    await rm(captured.root, { force: true, recursive: true });
  }

  const overridden = await bootstrapFixture({
    envSource: "CONTAINER_USER=2222:3333\n",
  });
  try {
    await overridden.run();
    assert.equal(
      await readFile(path.join(overridden.root, ".env"), "utf8"),
      "CONTAINER_USER=2222:3333\n",
    );
  } finally {
    await rm(overridden.root, { force: true, recursive: true });
  }
});

test("bootstrap fails closed for a root host identity", async () => {
  const fixture = await bootstrapFixture({ envSource: "", uid: 0, gid: 0 });
  try {
    await assert.rejects(fixture.run(), /non-root host UID and GID/);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("bootstrap rejects an existing environment file with unsafe permissions", async () => {
  const fixture = await bootstrapFixture({ envSource: "" });
  try {
    const envPath = path.join(fixture.root, ".env");
    await writeFile(envPath, "CONTAINER_USER=1234:5678\n", "utf8");
    await chmod(envPath, 0o644);
    await assert.rejects(fixture.run(), /\.env must have mode 600/u);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("bootstrap rejects a symlinked environment file", async () => {
  const fixture = await bootstrapFixture({ envSource: "" });
  try {
    await writeFile(path.join(fixture.root, "outside.env"), "secret\n", "utf8");
    await (await import("node:fs/promises")).symlink(
      "outside.env",
      path.join(fixture.root, ".env"),
    );
    await assert.rejects(fixture.run(), /symlinked \.env/u);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});
