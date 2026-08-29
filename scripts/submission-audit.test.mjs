import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";

import {
  assertTrustedToolFile,
  inspectArchitecture,
  inspectGit,
  inspectLocalVerification,
  inspectSubmissionReadiness as inspectSubmissionReadinessImplementation,
} from "./submission-audit.mjs";

test("accepts only system-contained symbolic links for trusted shells", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "airlock-system-shell-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const systemBin = path.join(root, "system-bin");
  const outsideBin = path.join(root, "outside-bin");
  await Promise.all([
    mkdir(systemBin),
    mkdir(outsideBin),
  ]);
  const shellTarget = path.join(systemBin, "dash");
  const outsideTarget = path.join(outsideBin, "hostile-shell");
  await Promise.all([
    writeFile(shellTarget, "trusted shell fixture\n"),
    writeFile(outsideTarget, "hostile shell fixture\n"),
  ]);
  const trustedLink = path.join(systemBin, "sh");
  const escapedLink = path.join(systemBin, "escaped-sh");
  await Promise.all([
    symlink(shellTarget, trustedLink),
    symlink(outsideTarget, escapedLink),
  ]);

  assert.equal(
    await assertTrustedToolFile(trustedLink, "POSIX shell executable", {
      allowSystemSymlink: true,
      systemRoots: [systemBin],
    }),
    await realpath(shellTarget),
  );
  await assert.rejects(
    assertTrustedToolFile(escapedLink, "POSIX shell executable", {
      allowSystemSymlink: true,
      systemRoots: [systemBin],
    }),
    /escaped the trusted system directories/,
  );
  await assert.rejects(
    assertTrustedToolFile(trustedLink, "dependency executable"),
    /not a trusted regular file/,
  );
});

const execFile = promisify(execFileCallback);
const npmCli = path.resolve(
  path.dirname(process.execPath),
  "../lib/node_modules/npm/bin/npm-cli.js",
);

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validArchitecture = async (root) => ({
  valid: true,
  width: 1904,
  height: 858,
  sourceDigest: sha256(
    await readFile(path.join(root, "docs/demo/agent-airlock-one-page.mmd")),
  ),
  imageDigest: sha256(
    await readFile(path.join(root, "docs/demo/agent-airlock-one-page.png")),
  ),
  manifestDigest: sha256(
    await readFile(path.join(root, "docs/demo/submission-assets.json")),
  ),
});
const passedLocalVerification = async () => ({ valid: true });
const boundSubmissionArtifacts = async ({ root }) => {
  const paths = [
    ...Object.keys(submissionDocuments()),
    "docs/demo/agent-airlock-one-page.mmd",
    "docs/demo/agent-airlock-one-page.png",
    "docs/demo/submission-assets.json",
  ];
  const artifacts = await Promise.all(
    paths.map(async (artifactPath) => ({
      path: artifactPath,
      sha256: sha256(await readFile(path.join(root, artifactPath))),
    })),
  );
  return {
    valid: true,
    revision: "a".repeat(40),
    artifactSetDigest: sha256(
      Buffer.from(JSON.stringify(artifacts), "utf8"),
    ),
    artifacts,
  };
};

function inspectSubmissionReadiness(options = {}) {
  return inspectSubmissionReadinessImplementation({
    ...options,
    architectureInspector:
      options.architectureInspector ?? validArchitecture,
    modelArkCopyInspector: options.modelArkCopyInspector ?? (() => true),
    artifactInspector:
      options.artifactInspector ?? boundSubmissionArtifacts,
    verificationInspector:
      options.verificationInspector ?? passedLocalVerification,
  });
}

function sha256(bytes) {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function png(width = 1904, height = 858, colorful = true) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rowBytes = width * 3 + 1;
  const pixels = Buffer.alloc(rowBytes * height);
  if (colorful) {
    for (let row = 0; row < height; row += 1) {
      const start = row * rowBytes + 1;
      pixels.fill(
        Buffer.from([row % 251, (row * 7) % 251, (row * 17) % 251]),
        start,
        start + rowBytes - 1,
      );
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const architectureSource = Buffer.from(
  [
    "TRACK 1",
    "AgentRunner seam",
    "Run-owned Candidate",
    "OUTCOME CONTRACT",
    "Quarantine",
    "Bounded Repair child",
    "optional ModelArk",
    "evidence only, never Promotion authority",
  ].join("\n"),
);

function submissionDocuments(videoUrl = null) {
  const video = videoUrl
    ? `Public three-minute demo video: ${videoUrl}`
    : "Public three-minute demo video: `[INSERT PUBLIC YOUTUBE URL]`";
  return {
    "README.md": [
      "TikTok TechJam 2026 selected track",
      "The live path must be rerun at judging time.",
    ].join("\n"),
    "docs/demo/DEVPOST_SUBMISSION.md": [
      "Track 1 - Agent Launchpad: Design and Build Lightweight Agent Middleware",
      "https://github.com/RrankPyramid/CodeJam",
      "- Public code repository: [github.com/Kk120306/agent-airlock](https://github.com/Kk120306/agent-airlock)",
      "separate optional conformance",
      "No ModelArk request",
      video,
    ].join("\n"),
    "docs/demo/SUBMISSION_BRIEF.md": [
      "shared `AgentRunner` boundary",
      "Live ModelArk is a separate optional conformance encore",
    ].join("\n"),
    "docs/demo/JUDGE_CHECKLIST.md":
      "The single unchecked item is the optional provider-backed ModelArk conformance rerun",
    "docs/product/PRD.md": "Live ModelArk remains pending provider capacity.",
    "docs/product/OUTCOME_ROADMAP.md":
      "Live ModelArk remains pending provider capacity.",
    "docs/demo/architecture-one-page.md":
      "agent-airlock-one-page.png agent-airlock-one-page.mmd\nLive ModelArk remains optional.",
    "docs/demo/three-minute-demo.md":
      "The Runtime fixture is canonical and live ModelArk remains optional.",
  };
}

async function fixture(videoUrl = null) {
  const root = await mkdtemp(path.join(os.tmpdir(), "airlock-submission-audit-"));
  const files = submissionDocuments(videoUrl);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  const image = png();
  await writeFile(
    path.join(root, "docs/demo/agent-airlock-one-page.mmd"),
    architectureSource,
  );
  await writeFile(path.join(root, "docs/demo/agent-airlock-one-page.png"), image);
  await writeFile(
    path.join(root, "docs/demo/submission-assets.json"),
    JSON.stringify({
      schema: "agent-airlock/submission-assets",
      schemaVersion: 1,
      architecture: {
        source: {
          file: "docs/demo/agent-airlock-one-page.mmd",
          bytes: architectureSource.length,
          sha256: sha256(architectureSource),
        },
        image: {
          file: "docs/demo/agent-airlock-one-page.png",
          bytes: image.length,
          sha256: sha256(image),
          width: 1904,
          height: 858,
        },
      },
    }),
  );
  return root;
}

async function writeArchitectureManifest(
  root,
  image,
  {
    sourceFile = "docs/demo/agent-airlock-one-page.mmd",
    imageFile = "docs/demo/agent-airlock-one-page.png",
    width = 1904,
    height = 858,
  } = {},
) {
  await writeFile(
    path.join(root, "docs/demo/submission-assets.json"),
    JSON.stringify({
      schema: "agent-airlock/submission-assets",
      schemaVersion: 1,
      architecture: {
        source: {
          file: sourceFile,
          bytes: architectureSource.length,
          sha256: sha256(architectureSource),
        },
        image: {
          file: imageFile,
          bytes: image.length,
          sha256: sha256(image),
          width,
          height,
        },
      },
    }),
  );
}

const cleanGit = async () => ({
  revision: "a".repeat(40),
  treeDigest: "b".repeat(40),
  objectFormat: "sha1",
  clean: true,
  repositoryMatches: true,
  originMainRevision: "a".repeat(40),
  originMainMatches: true,
});
const validRuntimeProof = async () => ({
  valid: true,
  schemaVersion: 2,
  source: {
    claim: "runner-observed-clean-git-state-not-signed",
    repository: "github:Kk120306/agent-airlock",
    objectFormat: "sha1",
    commitOid: "a".repeat(40),
    treeOid: "b".repeat(40),
    worktreeState: "clean",
  },
  chainBackedRuns: ["quarantine", "repair"],
  promotionClaim: "runner-observed-capsule-not-signed",
});
const missingModelArkProof = async () => {
  const error = new Error("missing");
  error.code = "ENOENT";
  throw error;
};

async function createSubmissionGitRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "airlock-submission-git-"));
  const git = (argumentsList) =>
    execFile("/usr/bin/git", argumentsList, {
      cwd: root,
      encoding: "utf8",
    });
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "airlock@example.test"]);
  await git(["config", "user.name", "Agent Airlock Test"]);
  await git([
    "remote",
    "add",
    "origin",
    "https://github.com/Kk120306/agent-airlock.git",
  ]);
  await writeFile(path.join(root, "tracked.txt"), "accepted\n");
  await git(["add", "tracked.txt"]);
  await git(["commit", "-m", "accepted source"]);
  await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return { root, git };
}

async function createVerificationRepository(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "airlock-verification-git-"));
  const git = (argumentsList) =>
    execFile("/usr/bin/git", argumentsList, {
      cwd: root,
      encoding: "utf8",
    });
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "airlock@example.test"]);
  await git(["config", "user.name", "Agent Airlock Test"]);
  const resolvedFiles = typeof files === "function" ? files(root) : files;
  for (const [relativePath, content] of Object.entries(resolvedFiles)) {
    await mkdir(path.dirname(path.join(root, relativePath)), {
      recursive: true,
    });
    await writeFile(path.join(root, relativePath), content);
  }
  await git(["add", "."]);
  await git(["commit", "-m", "verification source"]);
  return { root, git };
}

function dependencyFixtureLockfile() {
  return JSON.stringify({
    name: "airlock-verification-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "airlock-verification-fixture",
        version: "1.0.0",
        workspaces: ["vendor/*"],
        devDependencies: {
          typescript: "1.0.0",
          vite: "1.0.0",
          vitest: "1.0.0",
        },
      },
      "node_modules/typescript": {
        resolved: "vendor/typescript",
        link: true,
      },
      "node_modules/vite": {
        resolved: "vendor/vite",
        link: true,
      },
      "node_modules/vitest": {
        resolved: "vendor/vitest",
        link: true,
      },
      "vendor/typescript": {
        name: "typescript",
        version: "1.0.0",
        bin: { tsc: "bin/tsc" },
      },
      "vendor/vite": {
        name: "vite",
        version: "1.0.0",
        bin: { vite: "bin/vite.js" },
      },
      "vendor/vitest": {
        name: "vitest",
        version: "1.0.0",
        bin: { vitest: "vitest.mjs" },
      },
    },
  });
}

async function withProcessEnvironment(overrides, operation) {
  const previous = new Map(
    Object.keys(overrides).map((name) => [name, process.env[name]]),
  );
  try {
    Object.assign(process.env, overrides);
    return await operation();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("submission Git inspection ignores fake PATH and inherited repository selectors", async () => {
  const { root } = await createSubmissionGitRepository();
  const fakeBin = await mkdtemp(path.join(os.tmpdir(), "airlock-fake-git-"));
  try {
    await writeFile(
      path.join(fakeBin, "git"),
      "#!/bin/sh\nexit 97\n",
      { mode: 0o700 },
    );
    const inspected = await withProcessEnvironment(
      {
        PATH: fakeBin,
        GIT_DIR: "/attacker/repository.git",
        GIT_WORK_TREE: "/attacker/worktree",
        GIT_NO_REPLACE_OBJECTS: "0",
        GIT_OPTIONAL_LOCKS: "1",
      },
      () => inspectGit(root),
    );
    assert.equal(inspected.clean, true);
    assert.equal(inspected.repositoryMatches, true);
    assert.equal(inspected.originMainMatches, true);
  } finally {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(fakeBin, { recursive: true, force: true }),
    ]);
  }
});

for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
  test(`submission Git inspection rejects ${flag} hidden bytes`, async () => {
    const { root, git } = await createSubmissionGitRepository();
    try {
      await git(["update-index", flag, "tracked.txt"]);
      await writeFile(path.join(root, "tracked.txt"), "hidden mutation\n");
      assert.equal(
        (
          await git([
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
          ])
        ).stdout,
        "",
      );
      await assert.rejects(inspectGit(root), /default index flags/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("runs the release auditor directly after the complete quality pipeline", async () => {
  const { root } = await createSubmissionGitRepository();
  const calls = [];
  const execute = async (command, argumentsList, options) => {
    calls.push({ command, argumentsList, options });
    return { stdout: "", stderr: "" };
  };
  try {
    const result = await inspectLocalVerification(root, execute);

    assert.equal(result.valid, true);
    assert.equal(result.dependencyInstall, "clean-exact-head-offline-npm-ci");
    assert.deepEqual(
      calls.map(({ command, argumentsList }) => [command, argumentsList]),
      [
        [
          process.execPath,
          [npmCli, "ci", "--ignore-scripts", "--offline"],
        ],
        [process.execPath, [npmCli, "run", "check"]],
        [process.execPath, [path.join(root, "scripts/release-audit.mjs")]],
      ],
    );
    assert.notEqual(calls[0].options.cwd, root);
    assert.equal(calls[1].options.cwd, calls[0].options.cwd);
    assert.equal(calls[2].options.cwd, root);
    assert.equal(
      calls.some(({ command, argumentsList }) =>
        command === "npm" && argumentsList.includes("audit:release"),
      ),
      false,
    );
    for (const { options } of calls) {
      assert.deepEqual(Object.keys(options.env).sort(), [
        "CI",
        "PATH",
        "npm_config_audit",
        "npm_config_cache",
        "npm_config_fund",
        "npm_config_globalconfig",
        "npm_config_ignore_scripts",
        "npm_config_node_options",
        "npm_config_offline",
        "npm_config_script_shell",
        "npm_config_update_notifier",
        "npm_config_userconfig",
      ]);
      assert.equal(
        path.basename(options.env.npm_config_script_shell),
        "trusted-script-shell",
      );
      assert.equal(
        options.env.PATH.includes(`${path.sep}node_modules${path.sep}.bin`),
        false,
      );
      assert.equal(options.env.npm_config_node_options, "--no-warnings");
      assert.equal(options.env.npm_config_offline, "true");
      assert.equal("NODE_OPTIONS" in options.env, false);
      assert.equal("BASH_ENV" in options.env, false);
      assert.equal("ENV" in options.env, false);
    }
    assert.equal(calls[0].options.env.npm_config_ignore_scripts, "true");
    assert.equal(calls[1].options.env.npm_config_ignore_scripts, "false");
    assert.equal(calls[2].options.env.npm_config_ignore_scripts, "false");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a project npmrc that could neutralize the real check script", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "airlock-project-npmrc-"));
  try {
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        private: true,
        scripts: { check: 'node -e "process.exit(17)"' },
      }),
    );
    await writeFile(
      path.join(root, "scripts", "preload.cjs"),
      'if (process.env.npm_lifecycle_event === "check") process.exit(0);\n',
    );
    await writeFile(
      path.join(root, ".npmrc"),
      `node-options=--require=${path.join(root, "scripts", "preload.cjs")}\n`,
    );
    await writeFile(
      path.join(root, "scripts", "release-audit.mjs"),
      "process.exitCode = 0;\n",
    );

    await assert.rejects(
      inspectLocalVerification(root),
      /Project npm configuration is forbidden/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not inherit npm, Node, or shell execution overrides", async () => {
  const { root } = await createSubmissionGitRepository();
  const original = {
    npm_config_script_shell: process.env.npm_config_script_shell,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    BASH_ENV: process.env.BASH_ENV,
    ENV: process.env.ENV,
    NPM_CONFIG_USERCONFIG: process.env.NPM_CONFIG_USERCONFIG,
  };
  Object.assign(process.env, {
    npm_config_script_shell: "/usr/bin/true",
    NODE_OPTIONS: "--require=/tmp/untrusted.cjs",
    BASH_ENV: "/tmp/untrusted-bash-env",
    ENV: "/tmp/untrusted-shell-env",
    NPM_CONFIG_USERCONFIG: "/tmp/untrusted-npmrc",
  });
  try {
    const environments = [];
    await inspectLocalVerification(root, async (_command, _args, options) => {
      environments.push(options.env);
      return { stdout: "", stderr: "" };
    });
    assert.equal(environments.length, 3);
    for (const environment of environments) {
      assert.equal(
        path.basename(environment.npm_config_script_shell),
        "trusted-script-shell",
      );
      assert.equal(
        environment.PATH.includes(`${path.sep}node_modules${path.sep}.bin`),
        false,
      );
      assert.equal("NODE_OPTIONS" in environment, false);
      assert.equal("BASH_ENV" in environment, false);
      assert.equal("ENV" in environment, false);
      assert.equal("NPM_CONFIG_USERCONFIG" in environment, false);
      assert.notEqual(
        environment.npm_config_userconfig,
        "/tmp/untrusted-npmrc",
      );
      assert.notEqual(
        environment.npm_config_userconfig,
        environment.npm_config_globalconfig,
      );
      assert.equal(environment.npm_config_offline, "true");
      assert.equal(
        environment.npm_config_userconfig.includes(
          `${path.sep}.local${path.sep}`,
        ),
        false,
      );
    }
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("ignores a hostile project-local npm user configuration in a real process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "airlock-verification-env-"));
  try {
    await mkdir(path.join(root, ".local"), { recursive: true });
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await writeFile(
      path.join(root, ".local", "release-audit-empty-npmrc"),
      "script-shell=/usr/bin/true\n",
    );
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "airlock-npm-config-fixture",
        version: "1.0.0",
        private: true,
        scripts: { check: "node scripts/write-verification-sentinel.mjs" },
      }),
    );
    await writeFile(
      path.join(root, "package-lock.json"),
      JSON.stringify({
        name: "airlock-npm-config-fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "airlock-npm-config-fixture",
            version: "1.0.0",
          },
        },
      }),
    );
    await writeFile(path.join(root, ".gitignore"), ".local/\nverified.txt\n");
    await writeFile(
      path.join(root, "scripts", "write-verification-sentinel.mjs"),
      `import { writeFile } from "node:fs/promises";\nawait writeFile(${JSON.stringify(path.join(root, "verified.txt"))}, "ran");\n`,
    );
    await writeFile(
      path.join(root, "scripts", "release-audit.mjs"),
      "process.exitCode = 0;\n",
    );
    const git = (argumentsList) =>
      execFile("/usr/bin/git", argumentsList, {
        cwd: root,
        encoding: "utf8",
      });
    await git(["init", "-b", "main"]);
    await git(["config", "user.email", "airlock@example.test"]);
    await git(["config", "user.name", "Agent Airlock Test"]);
    await git(["add", "."]);
    await git(["commit", "-m", "npm config fixture"]);

    const result = await inspectLocalVerification(root);
    assert.equal(result.valid, true);
    await access(path.join(root, "verified.txt"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verifies with clean lockfile dependencies when current node_modules tools are tampered", async () => {
  const { root } = await createVerificationRepository((repositoryRoot) => {
    const cleanTool = (name) =>
      `import { writeFile } from "node:fs/promises";\nawait writeFile(${JSON.stringify(path.join(repositoryRoot, `clean-${name}.txt`))}, "verified");\n`;
    const toolManifest = (name, bin) =>
      JSON.stringify({ name, version: "1.0.0", type: "module", bin });
    return {
      ".gitignore": "node_modules/\nclean-*.txt\ntampered-*.txt\n",
      "package.json": JSON.stringify({
        name: "airlock-verification-fixture",
        version: "1.0.0",
        private: true,
        workspaces: ["vendor/*"],
        scripts: { check: "tsc && vitest && vite" },
        devDependencies: {
          typescript: "1.0.0",
          vite: "1.0.0",
          vitest: "1.0.0",
        },
      }),
      "package-lock.json": dependencyFixtureLockfile(),
      "scripts/release-audit.mjs": "process.exitCode = 0;\n",
      "vendor/typescript/package.json": toolManifest("typescript", {
        tsc: "bin/tsc",
      }),
      "vendor/typescript/bin/tsc": cleanTool("tsc"),
      "vendor/vitest/package.json": toolManifest("vitest", {
        vitest: "vitest.mjs",
      }),
      "vendor/vitest/vitest.mjs": cleanTool("vitest"),
      "vendor/vite/package.json": toolManifest("vite", {
        vite: "bin/vite.js",
      }),
      "vendor/vite/bin/vite.js": cleanTool("vite"),
    };
  });
  try {
    await Promise.all([
      mkdir(path.join(root, "node_modules", "typescript", "bin"), {
        recursive: true,
      }),
      mkdir(path.join(root, "node_modules", "vitest"), { recursive: true }),
      mkdir(path.join(root, "node_modules", "vite", "bin"), {
        recursive: true,
      }),
    ]);
    await Promise.all(
      ["typescript", "vite"].map((name) =>
        writeFile(
          path.join(root, "node_modules", name, "package.json"),
          JSON.stringify({ type: "module" }),
        ),
      ),
    );
    for (const [file, name] of [
      [path.join(root, "node_modules", "typescript", "bin", "tsc"), "tsc"],
      [path.join(root, "node_modules", "vitest", "vitest.mjs"), "vitest"],
      [path.join(root, "node_modules", "vite", "bin", "vite.js"), "vite"],
    ]) {
      await writeFile(
        file,
        `import { writeFile } from "node:fs/promises";\nawait writeFile(${JSON.stringify(path.join(root, `tampered-${name}.txt`))}, "wrong dependency bytes executed");\nprocess.exitCode = 0;\n`,
      );
    }

    const result = await inspectLocalVerification(root);
    assert.equal(result.valid, true);
    await Promise.all([
      access(path.join(root, "clean-tsc.txt")),
      access(path.join(root, "clean-vitest.txt")),
      access(path.join(root, "clean-vite.txt")),
    ]);
    for (const name of ["tsc", "vitest", "vite"]) {
      await assert.rejects(
        access(path.join(root, `tampered-${name}.txt`)),
        (error) => error?.code === "ENOENT",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports a ready core while separating unresolved owner and optional actions", async () => {
  const root = await fixture();
  try {
    const report = await inspectSubmissionReadiness({
      root,
      environment: {
        ARK_API_KEY: "private-secret-value",
        ARK_MODEL: "private-model-value",
        ARK_BASE_URL: "https://private-provider.example.test/api/v3",
      },
      gitInspector: cleanGit,
      runtimeProofInspector: validRuntimeProof,
      modelArkEvidenceInspector: missingModelArkProof,
    });
    assert.equal(report.networkRequests, 0);
    assert.equal(report.localIntegrityReady, true);
    assert.equal(report.coreDemoReady, true);
    assert.equal(report.submissionReady, false);
    assert.equal(
      report.checks.find((item) => item.id === "demo-video-link")?.status,
      "owner-action",
    );
    assert.equal(
      report.checks.find((item) => item.id === "modelark-config")?.status,
      "pass",
    );
    assert.equal(
      report.checks.find((item) => item.id === "modelark-live-evidence")
        ?.status,
      "optional-pending",
    );
    assert.doesNotMatch(
      JSON.stringify(report),
      /private-secret-value|private-model-value|private-provider/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("accepts only the pinned nonblank architecture render pair", async () => {
  const architecture = await inspectArchitecture(projectRoot);
  assert.equal(architecture.valid, true);
  assert.equal(architecture.width, 1904);
  assert.equal(architecture.height, 858);
});

test("accepts explicit owner confirmations only after a valid video URL exists", async () => {
  const root = await fixture("https://youtu.be/abc123xyz");
  try {
    const report = await inspectSubmissionReadiness({
      root,
      environment: {},
      confirmPublicRevision: "a".repeat(40),
      confirmVideoPublic: true,
      gitInspector: cleanGit,
      runtimeProofInspector: validRuntimeProof,
      modelArkEvidenceInspector: missingModelArkProof,
    });
    assert.equal(report.submissionReady, true);
    assert.deepEqual(
      report.checks
        .filter((item) => item.scope === "submission")
        .map((item) => item.status),
      ["pass", "pass", "owner-confirmed", "owner-confirmed"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an upstream repository field even when the expected URL appears elsewhere", async () => {
  const root = await fixture("https://youtu.be/abc123xyz");
  try {
    const file = path.join(root, "docs/demo/DEVPOST_SUBMISSION.md");
    const content = await readFile(file, "utf8");
    await writeFile(
      file,
      content.replace(
        "- Public code repository: [github.com/Kk120306/agent-airlock](https://github.com/Kk120306/agent-airlock)",
        "- Public code repository: [github.com/RrankPyramid/CodeJam](https://github.com/RrankPyramid/CodeJam)\n- One-page architecture: https://github.com/Kk120306/agent-airlock/blob/main/docs/demo/agent-airlock-one-page.png",
      ),
    );
    const report = await inspectSubmissionReadiness({
      root,
      environment: {},
      gitInspector: cleanGit,
      runtimeProofInspector: validRuntimeProof,
      modelArkEvidenceInspector: missingModelArkProof,
    });
    assert.equal(
      report.checks.find((item) => item.id === "track-one-copy")?.status,
      "fail",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a duplicated exact public repository field", async () => {
  const root = await fixture("https://youtu.be/abc123xyz");
  try {
    const file = path.join(root, "docs/demo/DEVPOST_SUBMISSION.md");
    const content = await readFile(file, "utf8");
    const line =
      "- Public code repository: [github.com/Kk120306/agent-airlock](https://github.com/Kk120306/agent-airlock)";
    await writeFile(file, content.replace(line, `${line}\n${line}`));
    const report = await inspectSubmissionReadiness({
      root,
      environment: {},
      gitInspector: cleanGit,
      runtimeProofInspector: validRuntimeProof,
      modelArkEvidenceInspector: missingModelArkProof,
    });
    assert.equal(
      report.checks.find((item) => item.id === "track-one-copy")?.status,
      "fail",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps the core unready when the full local verification gate fails", async () => {
  const root = await fixture("https://youtu.be/abc123xyz");
  try {
    const report = await inspectSubmissionReadiness({
      root,
      environment: {},
      gitInspector: cleanGit,
      runtimeProofInspector: validRuntimeProof,
      modelArkEvidenceInspector: missingModelArkProof,
      verificationInspector: async () => ({ valid: false }),
    });
    assert.equal(report.localIntegrityReady, false);
    assert.equal(report.coreDemoReady, false);
    assert.equal(report.submissionReady, false);
    assert.equal(
      report.checks.find((item) => item.id === "release-verification")?.status,
      "fail",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps the core unready when required artifacts are not bound to HEAD", async () => {
  const root = await fixture("https://youtu.be/abc123xyz");
  try {
    const report = await inspectSubmissionReadiness({
      root,
      environment: {},
      gitInspector: cleanGit,
      runtimeProofInspector: validRuntimeProof,
      modelArkEvidenceInspector: missingModelArkProof,
      artifactInspector: async () => ({ valid: false }),
    });
    assert.equal(report.localIntegrityReady, false);
    assert.equal(report.coreDemoReady, false);
    assert.equal(report.submissionReady, false);
    assert.equal(
      report.checks.find((item) => item.id === "submission-files")?.status,
      "fail",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails deterministic integrity when the architecture export drifts", async () => {
  const root = await fixture("https://www.youtube.com/watch?v=abc123xyz");
  try {
    await writeFile(
      path.join(root, "docs/demo/agent-airlock-one-page.png"),
      png(1200, 800),
    );
    const report = await inspectSubmissionReadiness({
      root,
      environment: {},
      architectureInspector: inspectArchitecture,
      confirmPublicRevision: "a".repeat(40),
      confirmVideoPublic: true,
      gitInspector: cleanGit,
      runtimeProofInspector: validRuntimeProof,
      modelArkEvidenceInspector: missingModelArkProof,
    });
    assert.equal(report.localIntegrityReady, false);
    assert.equal(report.coreDemoReady, false);
    assert.equal(
      report.checks.find((item) => item.id === "architecture-asset")?.status,
      "fail",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a signature-and-header-only fake PNG even when the manifest matches", async () => {
  const root = await fixture("https://youtu.be/abc123xyz");
  try {
    const fake = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(fake, 0);
    fake.writeUInt32BE(13, 8);
    fake.write("IHDR", 12, "ascii");
    fake.writeUInt32BE(1904, 16);
    fake.writeUInt32BE(858, 20);
    await writeFile(
      path.join(root, "docs/demo/agent-airlock-one-page.png"),
      fake,
    );
    await writeArchitectureManifest(root, fake);
    const report = await inspectSubmissionReadiness({
      root,
      environment: {},
      architectureInspector: inspectArchitecture,
      gitInspector: cleanGit,
      runtimeProofInspector: validRuntimeProof,
      modelArkEvidenceInspector: missingModelArkProof,
    });
    assert.equal(
      report.checks.find((item) => item.id === "architecture-asset")?.status,
      "fail",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects CRC-valid PNG chunks whose image stream cannot be decoded", async () => {
  const root = await fixture("https://youtu.be/abc123xyz");
  try {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1904, 0);
    header.writeUInt32BE(858, 4);
    header[8] = 8;
    header[9] = 2;
    const invalidImage = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk("IHDR", header),
      pngChunk("IDAT", Buffer.from("not-a-deflate-stream")),
      pngChunk("IEND", Buffer.alloc(0)),
    ]);
    await writeFile(
      path.join(root, "docs/demo/agent-airlock-one-page.png"),
      invalidImage,
    );
    await writeArchitectureManifest(root, invalidImage);
    const report = await inspectSubmissionReadiness({
      root,
      environment: {},
      architectureInspector: inspectArchitecture,
      gitInspector: cleanGit,
      runtimeProofInspector: validRuntimeProof,
      modelArkEvidenceInspector: missingModelArkProof,
    });
    assert.equal(
      report.checks.find((item) => item.id === "architecture-asset")?.status,
      "fail",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a CRC-valid blank RGB architecture export", async () => {
  const root = await fixture("https://youtu.be/abc123xyz");
  try {
    const blankImage = png(1904, 858, false);
    await writeFile(
      path.join(root, "docs/demo/agent-airlock-one-page.png"),
      blankImage,
    );
    await writeArchitectureManifest(root, blankImage);
    const report = await inspectSubmissionReadiness({
      root,
      environment: {},
      architectureInspector: inspectArchitecture,
      gitInspector: cleanGit,
      runtimeProofInspector: validRuntimeProof,
      modelArkEvidenceInspector: missingModelArkProof,
    });
    assert.equal(
      report.checks.find((item) => item.id === "architecture-asset")?.status,
      "fail",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an architecture manifest redirected to unrelated files", async () => {
  const root = await fixture("https://youtu.be/abc123xyz");
  try {
    const image = png();
    await writeFile(path.join(root, "docs/demo/unrelated.mmd"), architectureSource);
    await writeFile(path.join(root, "docs/demo/unrelated.png"), image);
    await writeArchitectureManifest(root, image, {
      sourceFile: "docs/demo/unrelated.mmd",
      imageFile: "docs/demo/unrelated.png",
    });
    const report = await inspectSubmissionReadiness({
      root,
      environment: {},
      architectureInspector: inspectArchitecture,
      gitInspector: cleanGit,
      runtimeProofInspector: validRuntimeProof,
      modelArkEvidenceInspector: missingModelArkProof,
    });
    assert.equal(
      report.checks.find((item) => item.id === "architecture-asset")?.status,
      "fail",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails stale ModelArk success language in submission-facing copy", async () => {
  const root = await fixture("https://youtu.be/abc123xyz");
  try {
    await writeFile(
      path.join(root, "docs/demo/SUBMISSION_BRIEF.md"),
      "shared `AgentRunner` boundary\nLive ModelArk is a separate optional conformance encore\nLive ModelArk conformance passed.",
    );
    const report = await inspectSubmissionReadiness({
      root,
      environment: {},
      gitInspector: cleanGit,
      runtimeProofInspector: validRuntimeProof,
      modelArkEvidenceInspector: missingModelArkProof,
      modelArkCopyInspector: () => false,
    });
    assert.equal(
      report.checks.find((item) => item.id === "modelark-honesty")?.status,
      "fail",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails stale ModelArk success language in linked demo assets", async () => {
  for (const file of [
    "docs/demo/three-minute-demo.md",
    "docs/demo/architecture-one-page.md",
  ]) {
    const root = await fixture("https://youtu.be/abc123xyz");
    try {
      await writeFile(
        path.join(root, file),
        file.endsWith("architecture-one-page.md")
          ? "agent-airlock-one-page.png agent-airlock-one-page.mmd\nLive ModelArk conformance passed."
          : "Live ModelArk conformance passed.",
      );
      const report = await inspectSubmissionReadiness({
        root,
        environment: {},
        gitInspector: cleanGit,
        runtimeProofInspector: validRuntimeProof,
        modelArkEvidenceInspector: missingModelArkProof,
        modelArkCopyInspector: () => false,
      });
      assert.equal(
        report.checks.find((item) => item.id === "modelark-honesty")?.status,
        "fail",
        file,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("does not accept an exact public-revision claim until HEAD matches origin/main", async () => {
  const root = await fixture("https://youtu.be/abc123xyz");
  try {
    const revision = "a".repeat(40);
    const report = await inspectSubmissionReadiness({
      root,
      environment: {},
      confirmPublicRevision: revision,
      confirmVideoPublic: true,
      gitInspector: async () => ({
        ...(await cleanGit()),
        originMainRevision: "c".repeat(40),
        originMainMatches: false,
      }),
      runtimeProofInspector: validRuntimeProof,
      modelArkEvidenceInspector: missingModelArkProof,
    });
    assert.equal(report.submissionReady, false);
    assert.equal(
      report.checks.find((item) => item.id === "source-control")?.status,
      "owner-action",
    );
    assert.equal(
      report.checks.find((item) => item.id === "repository-public")?.status,
      "owner-action",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [label, gitOverride, proofOverride] of [
  ["schema-v1 proof", {}, { schemaVersion: 1, source: null }],
  [
    "stale proof commit",
    {},
    { source: { ...(await validRuntimeProof()).source, commitOid: "c".repeat(40) } },
  ],
  [
    "mismatched proof tree",
    {},
    { source: { ...(await validRuntimeProof()).source, treeOid: "c".repeat(40) } },
  ],
  ["dirty worktree", { clean: false }, {}],
]) {
  test(`keeps the core unready for ${label}`, async () => {
    const root = await fixture("https://youtu.be/abc123xyz");
    try {
      const git = { ...(await cleanGit()), ...gitOverride };
      const proof = { ...(await validRuntimeProof()), ...proofOverride };
      const report = await inspectSubmissionReadiness({
        root,
        environment: {},
        gitInspector: async () => git,
        runtimeProofInspector: async () => proof,
        modelArkEvidenceInspector: missingModelArkProof,
      });
      assert.equal(report.coreDemoReady, false);
      assert.equal(report.submissionReady, false);
      assert.equal(
        report.checks.find((item) => item.id === "runtime-proof")?.status,
        "owner-action",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("requires the owner confirmation to name the exact audited revision", async () => {
  const root = await fixture("https://youtu.be/abc123xyz");
  try {
    const report = await inspectSubmissionReadiness({
      root,
      environment: {},
      confirmPublicRevision: "c".repeat(40),
      confirmVideoPublic: true,
      gitInspector: cleanGit,
      runtimeProofInspector: validRuntimeProof,
      modelArkEvidenceInspector: missingModelArkProof,
    });
    assert.equal(report.submissionReady, false);
    assert.equal(
      report.checks.find((item) => item.id === "repository-public")?.status,
      "owner-action",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when Git moves between the initial and final inspection", async () => {
  const root = await fixture("https://youtu.be/abc123xyz");
  try {
    let calls = 0;
    const movedGit = async () => {
      calls += 1;
      return calls === 1
        ? cleanGit()
        : {
            ...(await cleanGit()),
            revision: "c".repeat(40),
            treeDigest: "d".repeat(40),
            originMainRevision: "c".repeat(40),
          };
    };
    const report = await inspectSubmissionReadiness({
      root,
      environment: {},
      gitInspector: movedGit,
      runtimeProofInspector: validRuntimeProof,
      modelArkEvidenceInspector: missingModelArkProof,
    });

    assert.equal(report.coreDemoReady, false);
    assert.equal(report.submissionReady, false);
    assert.equal(report.sourceRevision, "c".repeat(40));
    assert.equal(
      report.checks.find((item) => item.id === "handoff-stability")?.status,
      "fail",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when verification is run across different Git revisions", async () => {
  const root = await fixture("https://youtu.be/abc123xyz");
  try {
    let calls = 0;
    const switchedGit = async () => {
      calls += 1;
      return calls === 1
        ? {
            ...(await cleanGit()),
            revision: "c".repeat(40),
            treeDigest: "d".repeat(40),
            originMainRevision: "c".repeat(40),
          }
        : cleanGit();
    };
    const report = await inspectSubmissionReadiness({
      root,
      environment: {},
      gitInspector: switchedGit,
      runtimeProofInspector: validRuntimeProof,
      modelArkEvidenceInspector: missingModelArkProof,
    });

    assert.equal(report.coreDemoReady, false);
    assert.equal(report.submissionReady, false);
    assert.equal(
      report.checks.find((item) => item.id === "release-verification")?.status,
      "fail",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when a required artifact drifts after the core checks", async () => {
  const root = await fixture("https://youtu.be/abc123xyz");
  try {
    let calls = 0;
    const report = await inspectSubmissionReadiness({
      root,
      environment: {},
      gitInspector: cleanGit,
      runtimeProofInspector: validRuntimeProof,
      modelArkEvidenceInspector: missingModelArkProof,
      artifactInspector: async () => {
        calls += 1;
        return { valid: calls === 1 };
      },
    });

    assert.equal(report.coreDemoReady, false);
    assert.equal(report.submissionReady, false);
    assert.equal(calls, 2);
    assert.equal(
      report.checks.find((item) => item.id === "handoff-stability")?.status,
      "fail",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when semantic copy is read from a transient file snapshot", async () => {
  const root = await fixture();
  try {
    const read = async (file, encoding) => {
      const content = await readFile(file, encoding);
      if (file === path.join(root, "docs/demo/DEVPOST_SUBMISSION.md")) {
        return content.replace(
          "Public three-minute demo video: `[INSERT PUBLIC YOUTUBE URL]`",
          "Public three-minute demo video: https://youtu.be/abc123xyz",
        );
      }
      return content;
    };
    const report = await inspectSubmissionReadiness({
      root,
      environment: {},
      gitInspector: cleanGit,
      runtimeProofInspector: validRuntimeProof,
      modelArkEvidenceInspector: missingModelArkProof,
      read,
    });

    assert.equal(
      report.checks.find((item) => item.id === "demo-video-link")?.status,
      "pass",
    );
    assert.equal(
      report.checks.find((item) => item.id === "handoff-stability")?.status,
      "fail",
    );
    assert.equal(report.submissionReady, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed when architecture semantics use bytes outside the artifact snapshot", async () => {
  const root = await fixture("https://youtu.be/abc123xyz");
  try {
    const report = await inspectSubmissionReadiness({
      root,
      environment: {},
      gitInspector: cleanGit,
      runtimeProofInspector: validRuntimeProof,
      modelArkEvidenceInspector: missingModelArkProof,
      architectureInspector: async () => ({
        valid: true,
        width: 1904,
        height: 858,
        sourceDigest: "sha256:" + "c".repeat(64),
        imageDigest: "sha256:" + "d".repeat(64),
        manifestDigest: "sha256:" + "e".repeat(64),
      }),
    });

    assert.equal(
      report.checks.find((item) => item.id === "architecture-asset")?.status,
      "pass",
    );
    assert.equal(
      report.checks.find((item) => item.id === "handoff-stability")?.status,
      "fail",
    );
    assert.equal(report.coreDemoReady, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
