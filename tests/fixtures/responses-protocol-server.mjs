import { createServer } from "node:http";

const host = process.env.AIRLOCK_PROTOCOL_FIXTURE_HOST ?? "0.0.0.0";
const port = Number(process.env.AIRLOCK_PROTOCOL_FIXTURE_PORT ?? "43991");
const maximumRequestBytes = 2 * 1024 * 1024;
let responseSequence = 0;

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
            text: "Protocol fixture completed the requested Candidate edit.",
          },
        ],
      },
    });
  } else {
    events.push({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: `call-fixture-write-${responseSequence}`,
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: "printf 'candidate-only\\n' > protocol-proof.txt",
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
