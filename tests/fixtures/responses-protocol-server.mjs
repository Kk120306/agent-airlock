import { createServer } from "node:http";

const host = process.env.AIRLOCK_PROTOCOL_FIXTURE_HOST ?? "0.0.0.0";
const port = Number(process.env.AIRLOCK_PROTOCOL_FIXTURE_PORT ?? "43991");
const maximumRequestBytes = 2 * 1024 * 1024;
let responseSequence = 0;
const toolCallModes = new Map();

function eventStream(events) {
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function completed(responseId) {
  return {
    type: "response.completed",
    response: {
      id: responseId,
      usage: {
        input_tokens: 1,
        input_tokens_details: null,
        output_tokens: 1,
        output_tokens_details: null,
        total_tokens: 2,
      },
    },
  };
}

function sendEvents(response, events) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "close",
  });
  response.end(eventStream(events));
}

function wholeAgentCommand(mode) {
  const proofValue = mode === "unsafe" ? "unsafe-candidate" : "candidate-only";
  const databaseValue = mode === "unsafe" ? "unsafe-candidate" : "candidate-only";
  const timestamp =
    mode === "repair"
      ? "2026-08-28T00:02:00.000Z"
      : mode === "unsafe"
        ? "2026-08-28T00:01:00.000Z"
        : "2026-08-28T00:00:00.000Z";
  const intent = {
    schemaVersion: 1,
    id:
      mode === "repair"
        ? "protocol-repair-ready"
        : mode === "unsafe"
          ? "protocol-unsafe"
          : "protocol-release-ready",
    type: "demo.notification.requested",
    payload: {
      destination: "demo-console",
      subject:
        mode === "repair"
          ? "Protocol repair ready"
          : mode === "unsafe"
            ? "Unsafe protocol Candidate"
            : "Protocol release ready",
      body:
        mode === "unsafe"
          ? "This Candidate effect must remain quarantined."
          : "The Whole-Agent Candidate passed.",
    },
  };
  const databaseScript = [
    'import { DatabaseSync } from "node:sqlite";',
    'const database = new DatabaseSync(".airlock/demo.sqlite");',
    'database.prepare("UPDATE inventory SET value = ?, updated_at = ? WHERE id = ?").run(',
    JSON.stringify(databaseValue) + ",",
    JSON.stringify(timestamp) + ",",
    '"demo");',
    "database.close();",
  ].join(" ");
  return [
    "printf " + JSON.stringify(proofValue + "\\n") + " > protocol-proof.txt",
    "node --no-warnings --experimental-sqlite --input-type=module -e " +
      JSON.stringify(databaseScript),
    "printf '%s\\n' " +
      JSON.stringify(JSON.stringify(intent)) +
      ' > "$AIRLOCK_OUTBOX_PATH"',
  ].join(" && ");
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(204).end();
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    response.writeHead(404).end();
    return;
  }
  if (
    request.headers.authorization !==
    "Bearer deterministic-protocol-fixture"
  ) {
    response.writeHead(401).end();
    return;
  }

  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw) > maximumRequestBytes) {
      response.writeHead(413).end();
      return;
    }
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    response.writeHead(400).end();
    return;
  }
  const input = Array.isArray(body.input) ? body.input : [];
  const latestInput = input.at(-1);
  const hasToolResult =
    latestInput?.type === "function_call_output" ||
    latestInput?.type === "custom_tool_call_output";
  const toolCallId =
    typeof latestInput?.call_id === "string" ? latestInput.call_id : null;
  let latestUserInput = null;
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (input[index]?.role === "user") {
      latestUserInput = input[index];
      break;
    }
  }
  const currentUserText = JSON.stringify(latestUserInput ?? latestInput ?? "");
  const mode = hasToolResult
    ? toolCallId !== null
      ? toolCallModes.get(toolCallId) ?? "safe"
      : "safe"
    : /Agent Airlock Repair Run for quarantined transaction/i.test(currentUserText)
      ? "repair"
      : /unsafe protocol change|rejection proof/i.test(currentUserText)
        ? "unsafe"
        : "safe";
  if (hasToolResult && toolCallId !== null) toolCallModes.delete(toolCallId);
  responseSequence += 1;
  const responseId = `resp-fixture-${responseSequence}`;
  const events = [
    { type: "response.created", response: { id: responseId } },
  ];
  if (hasToolResult) {
    events.push({
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        id: `msg-fixture-${responseSequence}`,
        content: [
          {
            type: "output_text",
            text:
              mode === "unsafe"
                ? "Protocol fixture completed the deliberately invalid Candidate edit."
                : mode === "repair"
                  ? "Protocol fixture repaired the retained Candidate from bounded failure evidence."
                  : "Protocol fixture completed the requested Candidate edit.",
          },
        ],
      },
    });
  } else {
    const callId = `call-fixture-write-${responseSequence}`;
    toolCallModes.set(callId, mode);
    events.push({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: callId,
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: wholeAgentCommand(mode),
        }),
      },
    });
  }
  events.push(completed(responseId));
  sendEvents(response, events);
});

server.listen(port, host, () => {
  console.log(`[responses-protocol-fixture] ready on ${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
