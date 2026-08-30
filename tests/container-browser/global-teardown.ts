import { rmdir } from "node:fs/promises";
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
  try {
    await rmdir(managedRoot);
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      !["ENOENT", "ENOTEMPTY"].includes(String(error.code))
    ) {
      throw error;
    }
  }
}
