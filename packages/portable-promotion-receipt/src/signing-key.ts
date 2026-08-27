import { Buffer } from "node:buffer";
import { createPrivateKey } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
} from "node:fs/promises";
import path from "node:path";
import { canonicalize, parseCanonicalJson } from "./canonical.js";
import {
  exportPortablePublicJwk,
  generatePortableSigningKey,
  publicJwkFingerprint,
} from "./crypto.js";
import type { PortableSigningKeyMaterial } from "./types.js";

const MAXIMUM_PRIVATE_KEY_BYTES = 16_384;

export async function loadOrCreatePortableSigningKey(
  filePath: string,
): Promise<PortableSigningKeyMaterial> {
  let key: PortableSigningKeyMaterial | null = null;
  try {
    key = await loadPortableSigningKey(filePath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if (!key) {
    if (await identityMarkerExists(filePath)) {
      throw new Error(
        "Portable signing key is missing while its identity marker remains",
      );
    }
    const generated = generatePortableSigningKey();
    await writePortableSigningKey(filePath, generated.privateKeyPem).catch(
      async (error: unknown) => {
        if (!isAlreadyExists(error)) throw error;
      },
    );
    key = await loadPortableSigningKey(filePath);
  }
  await assertOrCreateIdentityMarker(filePath, key);
  return key;
}

export async function writeNewPortableSigningKey(
  filePath: string,
): Promise<PortableSigningKeyMaterial> {
  if (await identityMarkerExists(filePath)) {
    throw new Error("Portable signing key identity marker already exists");
  }
  const generated = generatePortableSigningKey();
  await writePortableSigningKey(filePath, generated.privateKeyPem);
  await writeIdentityMarker(filePath, generated);
  return generated;
}

export async function loadPortableSigningKey(
  filePath: string,
): Promise<PortableSigningKeyMaterial> {
  await assertPortableSigningKeyDirectory(filePath, false);
  const stats = await lstat(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("Portable signing key must be a regular non-symbolic-link file");
  }
  if (stats.size < 1 || stats.size > MAXIMUM_PRIVATE_KEY_BYTES) {
    throw new Error("Portable signing key exceeds its byte boundary");
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error("Portable signing key permissions must not allow group or world access");
  }
  const privateKeyPem = await readFile(filePath, "utf8");
  if (Buffer.byteLength(privateKeyPem, "utf8") > MAXIMUM_PRIVATE_KEY_BYTES) {
    throw new Error("Portable signing key exceeds its byte boundary");
  }
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Portable signing key must be an Ed25519 private key");
  }
  const publicJwk = exportPortablePublicJwk(privateKey);
  return {
    privateKeyPem,
    publicJwk,
    keyId: publicJwkFingerprint(publicJwk),
  };
}

async function writePortableSigningKey(
  filePath: string,
  privateKeyPem: string,
): Promise<void> {
  await assertPortableSigningKeyDirectory(filePath, true);
  const handle = await open(path.resolve(filePath), "wx", 0o600);
  try {
    await handle.writeFile(privateKeyPem, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== "win32") await chmod(path.resolve(filePath), 0o600);
}

async function assertPortableSigningKeyDirectory(
  filePath: string,
  create: boolean,
): Promise<void> {
  const directory = path.dirname(path.resolve(filePath));
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStats = await lstat(directory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error("Portable signing key parent must be a regular directory");
  }
  if (process.platform !== "win32" && (directoryStats.mode & 0o077) !== 0) {
    throw new Error(
      "Portable signing key parent permissions must not allow group or world access",
    );
  }
}

async function assertOrCreateIdentityMarker(
  filePath: string,
  key: PortableSigningKeyMaterial,
): Promise<void> {
  const markerPath = identityMarkerPath(filePath);
  try {
    const stats = await lstat(markerPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > 512) {
      throw new Error("Portable signing key identity marker is invalid");
    }
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      throw new Error(
        "Portable signing key identity marker permissions must not allow group or world access",
      );
    }
    const source = await readFile(markerPath, "utf8");
    const value = parseCanonicalJson(source, 512);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).sort().join("\u0000") !==
        ["keyId", "schema", "schemaVersion"].join("\u0000") ||
      value.schema !== "agent-airlock/portable-signing-key-identity" ||
      value.schemaVersion !== 1 ||
      value.keyId !== key.keyId ||
      canonicalize(value) !== source.trim()
    ) {
      throw new Error(
        "Portable signing key does not match its durable identity marker",
      );
    }
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await writeIdentityMarker(filePath, key).catch((error: unknown) => {
    if (!isAlreadyExists(error)) throw error;
  });
  await assertOrCreateIdentityMarker(filePath, key);
}

async function writeIdentityMarker(
  filePath: string,
  key: PortableSigningKeyMaterial,
): Promise<void> {
  const markerPath = identityMarkerPath(filePath);
  const serialized =
    canonicalize({
      schema: "agent-airlock/portable-signing-key-identity",
      schemaVersion: 1,
      keyId: key.keyId,
    }) + "\n";
  const handle = await open(markerPath, "wx", 0o600);
  try {
    await handle.writeFile(serialized, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== "win32") await chmod(markerPath, 0o600);
}

function identityMarkerPath(filePath: string): string {
  return path.resolve(filePath) + ".key-id.json";
}

async function identityMarkerExists(filePath: string): Promise<boolean> {
  try {
    await lstat(identityMarkerPath(filePath));
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}
