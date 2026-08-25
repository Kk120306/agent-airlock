import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { RunnerRequest } from "../src/types.js";

export async function persistFixtureSession(
  request: RunnerRequest,
  threadId: string,
  marker = request.prompt,
): Promise<void> {
  const sessionsPath = path.join(request.codexHomePath, "sessions", "fixture");
  await mkdir(sessionsPath, { recursive: true });
  await appendFile(
    path.join(sessionsPath, "rollout-" + threadId + ".jsonl"),
    JSON.stringify({ threadId, marker }) + "\n",
    "utf8",
  );
}
