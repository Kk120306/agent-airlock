import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const rootPackage = JSON.parse(
  await readFile(path.join(projectRoot, "package.json"), "utf8"),
);
const dockerfile = await readFile(path.join(projectRoot, "Dockerfile"), "utf8");
const installBoundary = dockerfile.indexOf("RUN npm ci");
const buildBoundary = dockerfile.indexOf("RUN npm run build");
if (installBoundary < 0 || buildBoundary < installBoundary) {
  throw new Error("Dockerfile must install the locked workspace before building it");
}
const beforeInstall = dockerfile.slice(0, installBoundary);
const beforeBuild = dockerfile.slice(0, buildBoundary);
const runtime = dockerfile.slice(dockerfile.indexOf("FROM ${NODE_IMAGE} AS runtime"));

const workspaceDirectories = ["apps/server", "apps/web"];
for (const pattern of rootPackage.workspaces ?? []) {
  if (pattern === "packages/*") {
    workspaceDirectories.push(
      "packages/transactional-resource-sdk",
      "packages/http-object-resource",
      "packages/portable-promotion-receipt",
    );
  }
}

for (const directory of workspaceDirectories) {
  const manifestCopy = `COPY ${directory}/package.json ${directory}/package.json`;
  if (!beforeInstall.includes(manifestCopy)) {
    throw new Error(
      `Docker dependency layer omits workspace manifest ${directory}/package.json`,
    );
  }
}
if (!beforeBuild.includes("COPY apps ./apps") || !beforeBuild.includes("COPY packages ./packages")) {
  throw new Error("Docker build layer omits application or package workspace sources");
}
for (const directory of workspaceDirectories.filter((item) => item.startsWith("packages/"))) {
  if (
    !runtime.includes(
      `COPY --from=build /app/${directory}/package.json ./${directory}/package.json`,
    ) ||
    !runtime.includes(`COPY --from=build /app/${directory}/dist ./${directory}/dist`)
  ) {
    throw new Error(`Docker runtime omits built workspace ${directory}`);
  }
}

process.stdout.write(
  `Docker workspace contract passed for ${workspaceDirectories.length} workspaces.\n`,
);
