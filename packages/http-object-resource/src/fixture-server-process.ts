import { startHttpObjectFixtureServer } from "./fixture-server.js";

const socketPath = process.env.AIRLOCK_HTTP_OBJECT_SOCKET;
const fixture = await startHttpObjectFixtureServer(
  socketPath ? { socketPath } : {},
);
process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    baseUrl: fixture.baseUrl,
    socketPath: socketPath ?? null,
    initialVersion: fixture.initialVersion,
  }) + "\n",
);

let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await fixture.close();
  process.exitCode = 0;
};

process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
