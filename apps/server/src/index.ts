import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig, writeCodexConfig } from "./config.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

const config = loadConfig();
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot, config.codexHome);
const runner = createRunner(config);
const service = new AgentService(config, store, workspaces, runner);
await service.initialize();
if (config.demoMode && service.listAgents().length === 0) {
  await service.createAgent({
    name: "Airlock Demo",
    description: "Promote, quarantine, repair, and continue one Agent future",
    instructions:
      "Follow the deterministic demo objective exactly and keep all changes inside the isolated Candidate State.",
  });
}

const app = await createApp(config, service);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
