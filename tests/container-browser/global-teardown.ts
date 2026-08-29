import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export default async function globalTeardown(): Promise<void> {
  const repositoryRoot = path.resolve(
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  const managedRoot = path.join(repositoryRoot, ".e2e-container-demo");
  if (
    path.dirname(managedRoot) !== repositoryRoot ||
    path.basename(managedRoot) !== ".e2e-container-demo"
  ) {
    throw new Error("Refusing to clean an unexpected container demo root");
  }
  await rm(managedRoot, { recursive: true, force: true });
}
