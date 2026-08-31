import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

import {
  createProductionImageProvenance,
  validateDockerArchiveLoad,
  verifyProductionImageProvenance,
} from "./production-image-provenance.mjs";

const root = await mkdtemp(path.join(tmpdir(), "airlock-image-provenance-"));
const projectRoot = path.resolve(".");
const execFile = promisify(execFileCallback);
const source = Object.freeze({
  claim: "runner-observed-clean-git-state-not-signed",
  commitOid: "2".repeat(40),
  objectFormat: "sha1",
  repository: "github:Kk120306/agent-airlock",
  treeOid: "3".repeat(40),
  worktreeState: "clean",
});

const inspectSource = async () => structuredClone(source);
const validateArchive = async () => undefined;

function sha256(bytes) {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

function inspectImageFor(observation) {
  return async () => structuredClone(observation);
}

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function createFixture({
  modern = false,
  optionLikeLayer = false,
  repoTags = null,
  wrongDiffId = false,
} = {}) {
  const archivePath = path.join(root, "agent-airlock-production-image.tar");
  const archiveRoot = path.join(root, "archive");
  const layerSource = path.join(root, "layer-source");
  await rm(archiveRoot, { recursive: true, force: true });
  await rm(layerSource, { recursive: true, force: true });
  await mkdir(path.join(archiveRoot, "layer"), { recursive: true });
  await mkdir(layerSource, { recursive: true });
  await writeFile(path.join(layerSource, "file.txt"), "layer\n");
  await execFile("tar", [
    "-cf",
    path.join(archiveRoot, "layer", "layer.tar"),
    "-C",
    layerSource,
    "file.txt",
  ]);
  const layerBytes = await readFile(
    path.join(archiveRoot, "layer", "layer.tar"),
  );
  const layerDigest = sha256(layerBytes);
  const configBytes = Buffer.from(
    JSON.stringify({
      architecture: "amd64",
      config: {
        Labels: {
          "io.agent-airlock.source-tree": source.treeOid,
          "org.opencontainers.image.revision": source.commitOid,
        },
      },
      os: "linux",
      rootfs: {
        diff_ids: [wrongDiffId ? "sha256:" + "0".repeat(64) : layerDigest],
        type: "layers",
      },
    }) + "\n",
  );
  const configDigest = sha256(configBytes);
  const archiveLayerBytes = modern ? gzipSync(layerBytes) : layerBytes;
  const archiveLayerDigest = sha256(archiveLayerBytes);
  const layerName = modern
    ? "blobs/sha256/" + archiveLayerDigest.slice("sha256:".length)
    : optionLikeLayer
      ? "--checkpoint=1/layer.tar"
      : "layer/layer.tar";
  let imageId = configDigest;
  let configName = configDigest.slice("sha256:".length) + ".json";
  let extraMembers = [];
  if (modern) {
    configName = "blobs/sha256/" + configDigest.slice("sha256:".length);
    const runnableManifestBytes = Buffer.from(
      JSON.stringify({
        config: {
          digest: configDigest,
          mediaType: "application/vnd.oci.image.config.v1+json",
          size: configBytes.length,
        },
        layers: [
          {
            digest: archiveLayerDigest,
            mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
            size: archiveLayerBytes.length,
          },
        ],
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        schemaVersion: 2,
      }),
    );
    const runnableManifestDigest = sha256(runnableManifestBytes);
    const runnableManifestName =
      "blobs/sha256/" + runnableManifestDigest.slice("sha256:".length);
    const rootIndexBytes = Buffer.from(
      JSON.stringify({
        manifests: [
          {
            digest: runnableManifestDigest,
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            platform: { architecture: "amd64", os: "linux" },
            size: runnableManifestBytes.length,
          },
        ],
        mediaType: "application/vnd.oci.image.index.v1+json",
        schemaVersion: 2,
      }),
    );
    imageId = sha256(rootIndexBytes);
    const rootIndexName = "blobs/sha256/" + imageId.slice("sha256:".length);
    const archiveIndexBytes = Buffer.from(
      JSON.stringify({
        manifests: [
          {
            digest: imageId,
            mediaType: "application/vnd.oci.image.index.v1+json",
            size: rootIndexBytes.length,
          },
        ],
        mediaType: "application/vnd.oci.image.index.v1+json",
        schemaVersion: 2,
      }),
    );
    await mkdir(path.join(archiveRoot, "blobs", "sha256"), {
      recursive: true,
    });
    await Promise.all([
      writeFile(
        path.join(archiveRoot, "oci-layout"),
        JSON.stringify({ imageLayoutVersion: "1.0.0" }),
      ),
      writeFile(path.join(archiveRoot, "index.json"), archiveIndexBytes),
      writeFile(
        path.join(archiveRoot, runnableManifestName),
        runnableManifestBytes,
      ),
      writeFile(path.join(archiveRoot, rootIndexName), rootIndexBytes),
    ]);
    extraMembers = [
      "oci-layout",
      "index.json",
      rootIndexName,
      runnableManifestName,
    ];
  }
  await Promise.all([
    mkdir(path.dirname(path.join(archiveRoot, configName)), {
      recursive: true,
    }),
    mkdir(path.dirname(path.join(archiveRoot, layerName)), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(archiveRoot, configName), configBytes),
    writeFile(path.join(archiveRoot, layerName), archiveLayerBytes),
    writeFile(
      path.join(archiveRoot, "manifest.json"),
      JSON.stringify([
        {
          Config: configName,
          RepoTags: repoTags,
          Layers: [layerName],
        },
      ]),
    ),
  ]);
  await rm(archivePath, { force: true });
  await execFile("tar", [
    "-cf",
    archivePath,
    "-C",
    archiveRoot,
    "--",
    "manifest.json",
    ...extraMembers,
    configName,
    layerName,
  ]);
  const observedImage = {
    codexVersion: "codex-cli 0.111.0",
    id: imageId,
    platform: { architecture: "amd64", os: "linux" },
    rootfs: [layerDigest],
    source: { commitOid: source.commitOid, treeOid: source.treeOid },
  };
  const proof = await createProductionImageProvenance({
    archivePath,
    imageId,
    inspectImage: inspectImageFor(observedImage),
    inspectSource,
    projectRoot,
    validateArchive,
  });
  return {
    archivePath,
    archiveRoot,
    configName,
    imageId,
    layerName,
    layerSource,
    observedImage,
    proof,
  };
}

const verificationOptions = (observedImage) => ({
  artifactDirectory: root,
  inspectImage: inspectImageFor(observedImage),
  inspectSource,
  projectRoot,
  validateArchive,
});

test("production image provenance binds the exact image archive and proof closure", async () => {
  const { observedImage, proof } = await createFixture();

  assert.equal(
    await verifyProductionImageProvenance(
      proof,
      verificationOptions(observedImage),
    ),
    true,
  );
});

test("production image provenance accepts the modern Docker blob archive layout", async () => {
  const { observedImage, proof } = await createFixture({ modern: true });

  assert.equal(
    await verifyProductionImageProvenance(
      proof,
      verificationOptions(observedImage),
    ),
    true,
  );
  assert.equal(proof.archive.identity.kind, "oci-index");
  assert.notEqual(
    proof.image.id,
    proof.archive.identity.configDigest,
    "the daemon index ID must remain distinct from its OCI config digest",
  );
});

test("production image provenance rejects identity and source-binding mutations", async () => {
  const { observedImage, proof } = await createFixture();
  const mutations = [
    (value) => {
      value.image.id = "sha256:" + "0".repeat(64);
    },
    (value) => {
      value.image.codexVersion = "codex-cli 0.151.0";
    },
    (value) => {
      value.image.platform.architecture = "arm64";
    },
    (value) => {
      value.source.commitOid = "4".repeat(40);
    },
    (value) => {
      value.image.source.treeOid = "4".repeat(40);
    },
    (value) => {
      value.image.rootfs[0] = "sha256:" + "0".repeat(64);
    },
    (value) => {
      value.inputs.baseImage = "node:latest";
    },
    (value) => {
      value.inputs.files[0].sha256 = "sha256:" + "0".repeat(64);
    },
    (value) => {
      value.proofClosure[0].sha256 = "sha256:" + "0".repeat(64);
    },
    (value) => {
      value.archive.sha256 = "sha256:" + "0".repeat(64);
    },
    (value) => {
      value.archive.identity.configDigest = "sha256:" + "0".repeat(64);
    },
    (value) => {
      value.unreviewed = true;
    },
  ];

  for (const mutate of mutations) {
    const changed = structuredClone(proof);
    mutate(changed);
    assert.equal(
      await verifyProductionImageProvenance(
        changed,
        verificationOptions(observedImage),
      ),
      false,
    );
  }
});

test("production image provenance rejects a changed archive after recording", async () => {
  const { archivePath, observedImage, proof } = await createFixture();
  await writeFile(archivePath, "different archive bytes\n");

  assert.equal(
    await verifyProductionImageProvenance(
      proof,
      verificationOptions(observedImage),
    ),
    false,
  );
});

test("production image provenance rejects layer bytes that contradict the image config", async () => {
  const {
    archivePath,
    archiveRoot,
    configName,
    imageId,
    layerSource,
    observedImage,
  } = await createFixture();
  await writeFile(path.join(layerSource, "file.txt"), "different\n");
  await execFile("tar", [
    "-cf",
    path.join(archiveRoot, "layer", "layer.tar"),
    "-C",
    layerSource,
    "file.txt",
  ]);
  await rm(archivePath, { force: true });
  await execFile("tar", [
    "-cf",
    archivePath,
    "-C",
    archiveRoot,
    "--",
    "manifest.json",
    configName,
    "layer/layer.tar",
  ]);

  await assert.rejects(
    createProductionImageProvenance({
      archivePath,
      imageId,
      inspectImage: inspectImageFor(observedImage),
      inspectSource,
      projectRoot,
      validateArchive,
    }),
    /layer contradicts its config/,
  );
});

test("production image provenance rejects live image and source contradictions", async () => {
  const { imageId, observedImage } = await createFixture();
  const contradictoryImage = structuredClone(observedImage);
  contradictoryImage.platform.architecture = "arm64";
  await assert.rejects(
    createProductionImageProvenance({
      archivePath: path.join(root, "agent-airlock-production-image.tar"),
      imageId,
      inspectImage: inspectImageFor(contradictoryImage),
      inspectSource,
      projectRoot,
      validateArchive,
    }),
    /observations do not agree/,
  );
});

test("production image provenance fails closed when Docker cannot load the archive", async () => {
  const { archivePath, imageId, observedImage } = await createFixture();
  await assert.rejects(
    createProductionImageProvenance({
      archivePath,
      imageId,
      inspectImage: inspectImageFor(observedImage),
      inspectSource,
      projectRoot,
      validateArchive: async () => {
        throw new Error("load rejected");
      },
    }),
    /load rejected/,
  );
});

test("production image provenance rejects modern layers whose uncompressed digest contradicts the config", async () => {
  await assert.rejects(
    createFixture({ modern: true, wrongDiffId: true }),
    /layer contradicts its config/,
  );
});

test("production image provenance rejects option-like archive member names", async () => {
  await assert.rejects(
    createFixture({ optionLikeLayer: true }),
    /does not bind one exact image/,
  );
});

test("production image provenance rejects archives that can retarget a repository tag", async () => {
  await assert.rejects(
    createFixture({ repoTags: ["unrelated:latest"] }),
    /does not bind one exact image/,
  );
});

test("production image provenance rejects source and binding drift before loading the archive", async () => {
  const { observedImage, proof } = await createFixture();
  const changedInput = structuredClone(proof);
  changedInput.inputs.files[0].sha256 = "sha256:" + "0".repeat(64);
  const changedClosure = structuredClone(proof);
  changedClosure.proofClosure[0].sha256 = "sha256:" + "0".repeat(64);
  const changedSource = structuredClone(source);
  changedSource.commitOid = "4".repeat(40);
  changedSource.treeOid = "5".repeat(40);

  for (const [changedProof, changedInspectSource] of [
    [changedInput, inspectSource],
    [changedClosure, inspectSource],
    [proof, async () => structuredClone(changedSource)],
  ]) {
    let loadAttempts = 0;
    assert.equal(
      await verifyProductionImageProvenance(changedProof, {
        ...verificationOptions(observedImage),
        inspectSource: changedInspectSource,
        validateArchive: async () => {
          loadAttempts += 1;
        },
      }),
      false,
    );
    assert.equal(loadAttempts, 0);
  }
});

test("production image replay rejects an existing target without loading over it", async () => {
  const imageId = "sha256:" + "6".repeat(64);
  const calls = [];
  const executeDocker = async (_executable, args) => {
    calls.push(args);
    return {
      stdout: JSON.stringify([
        { Id: imageId, RepoTags: ["unrelated:latest"] },
      ]),
    };
  };

  await assert.rejects(
    validateDockerArchiveLoad("archive.tar", imageId, {
      executeDocker,
      requireAbsent: true,
    }),
    /replay target already exists/,
  );
  assert.equal(
    calls.some((args) => args[0] === "image" && args[1] === "load"),
    false,
  );
});

test("production image replay loads one fresh untagged image and exposes bounded rollback", async () => {
  const imageId = "sha256:" + "7".repeat(64);
  const calls = [];
  let imagePresent = false;
  const executeDocker = async (_executable, args) => {
    calls.push(args);
    if (args[0] === "image" && args[1] === "inspect") {
      if (!imagePresent) {
        const error = new Error("missing");
        error.code = 1;
        error.stderr = `Error response from daemon: No such image: ${imageId}`;
        throw error;
      }
      return { stdout: JSON.stringify([{ Id: imageId, RepoTags: null }]) };
    }
    if (args[0] === "image" && args[1] === "load") {
      imagePresent = true;
      return { stdout: `Loaded image ID: ${imageId}\n` };
    }
    if (args[0] === "image" && args[1] === "rm") {
      imagePresent = false;
      return { stdout: imageId + "\n" };
    }
    throw new Error("unexpected Docker invocation");
  };

  const ownership = await validateDockerArchiveLoad("archive.tar", imageId, {
    executeDocker,
    requireAbsent: true,
  });
  assert.equal(ownership.loadedFresh, true);
  assert.equal(imagePresent, true);
  await ownership.rollback();
  assert.equal(imagePresent, false);
  assert.equal(
    calls.filter((args) => args[0] === "image" && args[1] === "load").length,
    1,
  );
});

test("production image replay preserves a target that acquires an unrelated tag", async () => {
  const imageId = "sha256:" + "8".repeat(64);
  const calls = [];
  let imagePresent = false;
  const executeDocker = async (_executable, args) => {
    calls.push(args);
    if (args[0] === "image" && args[1] === "inspect") {
      if (!imagePresent) {
        const error = new Error("missing");
        error.code = 1;
        error.stderr = `Error response from daemon: No such object: ${imageId}`;
        throw error;
      }
      return {
        stdout: JSON.stringify([
          { Id: imageId, RepoTags: ["unrelated:latest"] },
        ]),
      };
    }
    if (args[0] === "image" && args[1] === "load") {
      imagePresent = true;
      return { stdout: `Loaded image ID: ${imageId}\n` };
    }
    throw new Error("unexpected Docker invocation");
  };

  await assert.rejects(
    validateDockerArchiveLoad("archive.tar", imageId, {
      executeDocker,
      requireAbsent: true,
    }),
    /not loadable as its exact image ID/,
  );
  assert.equal(imagePresent, true);
  assert.equal(
    calls.some((args) => args[0] === "image" && args[1] === "rm"),
    false,
  );
});

test("production image verification rolls back its fresh image after a live contradiction", async () => {
  const { observedImage, proof } = await createFixture();
  const contradictoryImage = structuredClone(observedImage);
  contradictoryImage.rootfs[0] = "sha256:" + "9".repeat(64);
  let loadAttempts = 0;
  let rollbacks = 0;

  assert.equal(
    await verifyProductionImageProvenance(proof, {
      ...verificationOptions(observedImage),
      inspectImage: inspectImageFor(contradictoryImage),
      validateArchive: async () => {
        loadAttempts += 1;
        return {
          loadedFresh: true,
          rollback: async () => {
            rollbacks += 1;
          },
        };
      },
    }),
    false,
  );
  assert.equal(loadAttempts, 1);
  assert.equal(rollbacks, 1);
});
