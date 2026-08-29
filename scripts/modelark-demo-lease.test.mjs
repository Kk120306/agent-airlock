import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import test from "node:test";
import {
  acquireModelArkDemoLease,
  acquireModelArkDemoStartupLease,
  releaseModelArkDemoLease,
} from "./modelark-demo-lease.mjs";

const staleNonce = "11111111-1111-4111-8111-111111111111";
const firstNonce = "22222222-2222-4222-8222-222222222222";
const secondNonce = "33333333-3333-4333-8333-333333333333";

test("an active owner prevents reset from touching the managed root", async () => {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), "airlock-modelark-lease-"),
  );
  const stateRoot = path.join(parent, "state");
  await mkdir(stateRoot);
  await writeFile(path.join(stateRoot, "keep.txt"), "keep\n");
  const first = acquireModelArkDemoLease({ stateRoot });
  try {
    assert.throws(
      () => acquireModelArkDemoLease({ stateRoot, resetRequested: true }),
      /already owned by an active proof/,
    );
    assert.equal(
      await readFile(path.join(stateRoot, "keep.txt"), "utf8"),
      "keep\n",
    );
  } finally {
    first.release();
    await rm(parent, { recursive: true, force: true });
  }
});

test("an outer supervisor releases only its exact drained-group lease", async () => {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), "airlock-modelark-lease-"),
  );
  const stateRoot = path.join(parent, "state");
  acquireModelArkDemoLease({
    stateRoot,
    ownerPid: 515,
    ownerProcessGroupId: 515,
    nonce: firstNonce,
  });
  try {
    assert.equal(
      releaseModelArkDemoLease({
        stateRoot,
        ownerPid: 515,
        nonce: secondNonce,
      }),
      false,
    );
    assert.equal(
      releaseModelArkDemoLease({
        stateRoot,
        ownerPid: 515,
        nonce: firstNonce,
      }),
      true,
    );
    assert.equal(
      releaseModelArkDemoLease({
        stateRoot,
        ownerPid: 515,
        nonce: firstNonce,
      }),
      false,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a symlinked parent resolves to one physical lease identity", async () => {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), "airlock-modelark-lease-"),
  );
  const physicalParent = path.join(parent, "physical");
  const aliasParent = path.join(parent, "alias");
  await mkdir(physicalParent);
  await symlink(physicalParent, aliasParent, "dir");
  const physicalRoot = path.join(physicalParent, "state");
  const aliasRoot = path.join(aliasParent, "state");
  const first = acquireModelArkDemoLease({ stateRoot: physicalRoot });
  try {
    assert.equal(
      first.stateRoot,
      path.join(await realpath(physicalParent), "state"),
    );
    assert.throws(
      () => acquireModelArkDemoLease({ stateRoot: aliasRoot }),
      /already owned by an active proof/,
    );
  } finally {
    first.release();
    await rm(parent, { recursive: true, force: true });
  }
});

test("a symlink leaf cannot alias a managed root", async () => {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), "airlock-modelark-lease-"),
  );
  const physicalRoot = path.join(parent, "physical");
  const aliasRoot = path.join(parent, "alias");
  await mkdir(physicalRoot);
  await symlink(physicalRoot, aliasRoot, "dir");
  const first = acquireModelArkDemoLease({ stateRoot: physicalRoot });
  try {
    assert.throws(
      () => acquireModelArkDemoLease({ stateRoot: aliasRoot }),
      /symbolic-link alias/,
    );
  } finally {
    first.release();
    await rm(parent, { recursive: true, force: true });
  }
});

test("a surviving owned process group blocks stale reset", async () => {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), "airlock-modelark-lease-"),
  );
  const stateRoot = path.join(parent, "state");
  const abandoned = acquireModelArkDemoLease({
    stateRoot,
    ownerPid: 999_999_999,
    ownerProcessGroupId: 424_242,
    nonce: staleNonce,
  });
  try {
    assert.throws(
      () =>
        acquireModelArkDemoLease({
          stateRoot,
          resetRequested: true,
          ownerPid: 202,
          nonce: secondNonce,
          processExists: () => false,
          processGroupExists: (processGroupId) => processGroupId === 424_242,
        }),
      /already owned by an active proof/,
    );
    const activeOwner = JSON.parse(
      await readFile(`${stateRoot}.active-proof/owner.json`, "utf8"),
    );
    assert.equal(activeOwner.nonce, staleNonce);
  } finally {
    abandoned.release();
    await rm(parent, { recursive: true, force: true });
  }
});

test("a legacy abandoned lease without a group identity fails closed", async () => {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), "airlock-modelark-lease-"),
  );
  const stateRoot = path.join(parent, "state");
  const leasePath = `${stateRoot}.active-proof`;
  await mkdir(leasePath, { mode: 0o700 });
  await writeFile(
    path.join(leasePath, "owner.json"),
    JSON.stringify({
      schema: "agent-airlock/modelark-demo-lease",
      schemaVersion: 1,
      ownerPid: 999_999_999,
      nonce: staleNonce,
    }) + "\n",
    { mode: 0o600 },
  );
  try {
    assert.throws(
      () =>
        acquireModelArkDemoLease({
          stateRoot,
          resetRequested: true,
          processExists: () => false,
        }),
      /no process-group identity and cannot be reset safely/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a surviving server blocks reset before stale lease takeover", async () => {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), "airlock-modelark-lease-"),
  );
  const stateRoot = path.join(parent, "state");
  await mkdir(stateRoot);
  await writeFile(path.join(stateRoot, "keep.txt"), "keep\n");
  const abandoned = acquireModelArkDemoLease({
    stateRoot,
    ownerPid: 999_999_999,
    nonce: staleNonce,
  });
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await assert.rejects(
      acquireModelArkDemoStartupLease({
        host: "127.0.0.1",
        port: address.port,
        stateRoot,
        resetRequested: true,
        ownerPid: 202,
        nonce: secondNonce,
        processExists: () => false,
      }),
      /demo port is already in use/,
    );
    const activeOwner = JSON.parse(
      await readFile(`${stateRoot}.active-proof/owner.json`, "utf8"),
    );
    assert.equal(activeOwner.nonce, staleNonce);
    assert.equal(
      await readFile(path.join(stateRoot, "keep.txt"), "utf8"),
      "keep\n",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try {
      abandoned.release();
    } catch {}
    await rm(parent, { recursive: true, force: true });
  }
});

test("reset recovers only an exact abandoned lease", async () => {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), "airlock-modelark-lease-"),
  );
  const stateRoot = path.join(parent, "state");
  const abandoned = acquireModelArkDemoLease({
    stateRoot,
    ownerPid: 999_999_999,
  });
  try {
    assert.throws(
      () =>
        acquireModelArkDemoLease({
          stateRoot,
          processExists: () => false,
        }),
      /abandoned proof lease/,
    );
    const recovered = acquireModelArkDemoLease({
      stateRoot,
      resetRequested: true,
      processExists: () => false,
    });
    recovered.release();
  } finally {
    try {
      abandoned.release();
    } catch {}
    await rm(parent, { recursive: true, force: true });
  }
});

test("staged publication lets only one interleaved owner become active", async () => {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), "airlock-modelark-lease-"),
  );
  const stateRoot = path.join(parent, "state");
  let winner;
  try {
    assert.throws(
      () =>
        acquireModelArkDemoLease({
          stateRoot,
          ownerPid: 101,
          nonce: firstNonce,
          processExists: (pid) => pid === 202,
          interleave(stage) {
            if (stage !== "after-owner-staged" || winner) return;
            winner = acquireModelArkDemoLease({
              stateRoot,
              ownerPid: 202,
              nonce: secondNonce,
            });
          },
        }),
      /already owned by an active proof/,
    );
    const activeOwner = JSON.parse(
      await readFile(`${stateRoot}.active-proof/owner.json`, "utf8"),
    );
    assert.equal(activeOwner.nonce, secondNonce);
    assert.deepEqual(await readdir(`${stateRoot}.active-proof`), [
      "owner.json",
    ]);
  } finally {
    winner?.release();
    await rm(parent, { recursive: true, force: true });
  }
});

test("a delayed stale observer never retires a newer owner", async () => {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), "airlock-modelark-lease-"),
  );
  const stateRoot = path.join(parent, "state");
  const abandoned = acquireModelArkDemoLease({
    stateRoot,
    ownerPid: 303,
    nonce: staleNonce,
  });
  let winner;
  try {
    assert.throws(
      () =>
        acquireModelArkDemoLease({
          stateRoot,
          resetRequested: true,
          ownerPid: 404,
          nonce: firstNonce,
          processExists: (pid) => pid === 505,
          interleave(stage) {
            if (stage !== "after-stale-inspection" || winner) return;
            winner = acquireModelArkDemoLease({
              stateRoot,
              resetRequested: true,
              ownerPid: 505,
              nonce: secondNonce,
              processExists: () => false,
            });
          },
        }),
      /already owned by an active proof/,
    );
    const activeOwner = JSON.parse(
      await readFile(`${stateRoot}.active-proof/owner.json`, "utf8"),
    );
    assert.equal(activeOwner.ownerPid, 505);
    assert.equal(activeOwner.nonce, secondNonce);
  } finally {
    winner?.release();
    try {
      abandoned.release();
    } catch {}
    await rm(parent, { recursive: true, force: true });
  }
});

test("a delayed takeover mover cannot rename a newly published lease", async () => {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), "airlock-modelark-lease-"),
  );
  const stateRoot = path.join(parent, "state");
  const abandoned = acquireModelArkDemoLease({
    stateRoot,
    ownerPid: 414,
    nonce: staleNonce,
  });
  let winner;
  try {
    assert.throws(
      () =>
        acquireModelArkDemoLease({
          stateRoot,
          resetRequested: true,
          ownerPid: 424,
          nonce: firstNonce,
          processExists: (pid) => pid === 434,
          interleave(stage) {
            if (stage !== "before-retire" || winner) return;
            winner = acquireModelArkDemoLease({
              stateRoot,
              resetRequested: true,
              ownerPid: 434,
              nonce: secondNonce,
              processExists: () => false,
            });
          },
        }),
      /already owned by an active proof/,
    );
    const activeOwner = JSON.parse(
      await readFile(`${stateRoot}.active-proof/owner.json`, "utf8"),
    );
    assert.equal(activeOwner.ownerPid, 434);
    assert.equal(activeOwner.nonce, secondNonce);
  } finally {
    winner?.release();
    try {
      abandoned.release();
    } catch {}
    await rm(parent, { recursive: true, force: true });
  }
});

test("reset completes a nonce-bound takeover after its claimant crashes", async () => {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), "airlock-modelark-lease-"),
  );
  const stateRoot = path.join(parent, "state");
  const abandoned = acquireModelArkDemoLease({
    stateRoot,
    ownerPid: 606,
    nonce: staleNonce,
  });
  let injected = false;
  try {
    assert.throws(
      () =>
        acquireModelArkDemoLease({
          stateRoot,
          resetRequested: true,
          ownerPid: 707,
          nonce: firstNonce,
          processExists: () => false,
          interleave(stage) {
            if (stage !== "after-claim-marker" || injected) return;
            injected = true;
            throw new Error("simulated claimant crash");
          },
        }),
      /simulated claimant crash/,
    );
    const recovered = acquireModelArkDemoLease({
      stateRoot,
      resetRequested: true,
      ownerPid: 808,
      nonce: secondNonce,
      processExists: () => false,
    });
    const activeOwner = JSON.parse(
      await readFile(`${stateRoot}.active-proof/owner.json`, "utf8"),
    );
    assert.equal(activeOwner.ownerPid, 808);
    recovered.release();
  } finally {
    try {
      abandoned.release();
    } catch {}
    await rm(parent, { recursive: true, force: true });
  }
});

test("a crash after retirement leaves no partial active lease", async () => {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), "airlock-modelark-lease-"),
  );
  const stateRoot = path.join(parent, "state");
  const abandoned = acquireModelArkDemoLease({
    stateRoot,
    ownerPid: 909,
    nonce: staleNonce,
  });
  let injected = false;
  try {
    assert.throws(
      () =>
        acquireModelArkDemoLease({
          stateRoot,
          resetRequested: true,
          ownerPid: 1_010,
          nonce: firstNonce,
          processExists: () => false,
          interleave(stage) {
            if (stage !== "after-retire" || injected) return;
            injected = true;
            throw new Error("simulated post-retirement crash");
          },
        }),
      /simulated post-retirement crash/,
    );
    const recovered = acquireModelArkDemoLease({
      stateRoot,
      ownerPid: 1_111,
      nonce: secondNonce,
    });
    const activeOwner = JSON.parse(
      await readFile(`${stateRoot}.active-proof/owner.json`, "utf8"),
    );
    assert.equal(activeOwner.ownerPid, 1_111);
    recovered.release();
  } finally {
    try {
      abandoned.release();
    } catch {}
    await rm(parent, { recursive: true, force: true });
  }
});

test("a crash after atomic release cannot leave an empty active directory", async () => {
  const parent = await mkdtemp(
    path.join(os.tmpdir(), "airlock-modelark-lease-"),
  );
  const stateRoot = path.join(parent, "state");
  let injected = false;
  const first = acquireModelArkDemoLease({
    stateRoot,
    ownerPid: 1_212,
    nonce: firstNonce,
    interleave(stage) {
      if (stage !== "after-release-retire" || injected) return;
      injected = true;
      throw new Error("simulated release crash");
    },
  });
  try {
    assert.throws(() => first.release(), /simulated release crash/);
    const recovered = acquireModelArkDemoLease({
      stateRoot,
      ownerPid: 1_313,
      nonce: secondNonce,
    });
    const activeOwner = JSON.parse(
      await readFile(`${stateRoot}.active-proof/owner.json`, "utf8"),
    );
    assert.equal(activeOwner.ownerPid, 1_313);
    recovered.release();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
