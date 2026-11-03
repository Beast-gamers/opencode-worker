# Remote reasoning worker

A single deployable HTTP worker that exposes one authenticated OpenCode server as a
remote LLM reasoning service. It is designed to sit behind a future gateway: the
gateway will call this worker; the worker calls OpenCode; OpenCode talks to the
configured model providers.

The worker is deliberately not an autonomous coding agent. It has one fixed system
prompt, no filesystem or shell access, and no ability to execute client-provided
tools. It can reason, generate code, answer questions, keep multi-turn sessions, and
return structured tool requests for a separate local agent to execute.

## Architecture

```text
gateway / API client
        |
        |  Bearer API key (worker)
        v
  worker HTTP API  (0.0.0.0:PORT)
        |
        |  Basic Auth, 127.0.0.1 only
        v
  OpenCode server  (127.0.0.1:OPENCODE_PORT)
        |
        v
  configured model provider(s)
```

One worker process owns one OpenCode process. OpenCode is never exposed outside the
container/host. The worker waits for OpenCode readiness and validates that the fixed
`worker` agent and exact system prompt are loaded before it starts serving.

## Fixed system prompt

The exact system prompt is in [`src/system-prompt.js`](src/system-prompt.js).

- Version: `remote-reasoning-v1`
- SHA-256: `f60631494e765148c0e2bd73d5463011540e764b7a7711cce326dc2168bdecbd`

The prompt is configured as the `worker` agent's system prompt in OpenCode. The
worker refuses to start unless OpenCode exposes that exact text for the `worker`
agent. Client-supplied `system` content is never placed in the system slot; it is
included in the user message as explicitly lower-priority, untrusted context.

OpenCode appends its own runtime harness context (model, environment, workspace and
similar metadata) after the configured agent system prompt. That suffix is added by
OpenCode itself, cannot be removed through its public config or API, and is not
controlled by the client. The fixed prompt is still first, and client instructions
can never replace it.

## Security model

The generated OpenCode configuration forces:

- `default_agent: "worker"` and a primary `worker` agent with the fixed prompt.
- A final deny-all permission rule for the worker agent and globally.
- `tools: { "*": false }`, `steps: 1`.
- Deny policies for tool, skill, MCP, and plugin use.
- Disabled update, share/autoshare, snapshots, formatter, LSP, instructions,
  commands, skills, MCP servers, and compaction.
- No extra tools, plugins, commands, references, or permission overrides.

Deploy-time `OPENCODE_EXTRA_CONFIG` may add providers/models, but the worker rejects
keys that could replace the identity or weaken the sandbox (for example `agents`,
`default_agent`, `permissions`, `policies`, `tools`, `mcp`, `plugins`, `skills`,
`instructions`, `update`, `share`).

Verified behavior with OpenCode 2.2.5:

- A model request for the native `write` tool fails with
  `No tool named "write" is currently available` and creates no file.
- The built-in `skill` tool may still be advertised by OpenCode, but execution is
  denied.
- Native tool attempts are returned only as `nativeToolEvents` diagnostics. They are
  never converted into worker-level `toolCalls`.
- The worker never executes a client tool and never fabricates tool results.

The worker does not provide general filesystem access, shell execution, or project
file discovery. Do not configure it with a workspace that contains secrets you are
unwilling to have indexed by OpenCode internals. Use an empty or disposable
`WORKSPACE` directory.

## Requirements

- Node.js 20.3 or newer
- OpenCode CLI 2.2.5 (`npm install -g @opencode/cli@2.2.5`)
- A configured model provider, supplied through `OPENCODE_EXTRA_CONFIG` and/or
  OpenCode's normal provider configuration

## Quick start

```bash
npm install
export API_KEY="$(openssl rand -hex 32)"
export WORKER_ID="reasoning-worker-1"
export HOME=/data
export WORKSPACE=/data/workspace
export OPENCODE_MODEL=opencode/big-pickle
npm start
```

All worker routes require the API key:

```bash
curl -H "Authorization: Bearer $API_KEY" http://127.0.0.1:3000/health
curl -H "Authorization: Bearer $API_KEY" http://127.0.0.1:3000/api/identity
```

## Docker

```bash
docker build -t opencode-reasoning-worker .

docker run --rm -p 3000:3000 \
  -e API_KEY="$(openssl rand -hex 32)" \
  -e WORKER_ID=reasoning-worker-1 \
  -e OPENCODE_MODEL=opencode/big-pickle \
  -v worker-data:/data \
  opencode-reasoning-worker
```

The image pins `@opencode/cli@2.2.5`, runs as the non-root `node` user, keeps runtime
data under `/data`, and uses an authenticated `/health` check. OpenCode listens on
`127.0.0.1:4100` inside the container; only the worker port is exposed.

## Configuration

Copy [`.env.example`](.env.example) and set at least `API_KEY` and `WORKER_ID`.
The worker reads environment variables directly; it does not load `.env` itself.

| Variable | Default | Purpose |
| --- | --- | --- |
| `API_KEY` | required | Bearer token required by every worker route |
| `WORKER_ID` | required | Stable worker identity returned by health/identity |
| `WORKER_NAME` | `opencode-remote-reasoning-worker` | Display name in identity |
| `HOST` | `0.0.0.0` | Worker listener address |
| `PORT` | `3000` | Worker listener port |
| `OPENCODE_PORT` | `4100` | Internal OpenCode port |
| `OPENCODE_BIN` | `opencode` | OpenCode executable |
| `OPENCODE_USERNAME` | `opencode` | Internal OpenCode Basic Auth user |
| `OPENCODE_PASSWORD` | random per start | Internal OpenCode Basic Auth password |
| `HOME` | `/data` | Runtime home for OpenCode state |
| `WORKSPACE` | `$HOME/workspace` | OpenCode working directory |
| `OPENCODE_MODEL` | none | Default model, `provider/model[#variant]` |
| `OPENCODE_EXTRA_CONFIG` | `{}` | JSON object merged into OpenCode config |
| `MAX_CONCURRENT_PROMPTS` | `4` | Worker-wide prompt concurrency |
| `PROMPT_TIMEOUT_MS` | `180000` | Default prompt wait timeout |
| `REQUEST_TIMEOUT_MS` | `30000` | General OpenCode request timeout |
| `OPENCODE_START_TIMEOUT_MS` | `120000` | Startup/readiness timeout |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | Graceful shutdown timeout |
| `BODY_LIMIT` | `10mb` | JSON body limit |
| `MAX_CONTEXT_MESSAGES` | `100` | Maximum client context messages |
| `MAX_TOOLS` | `64` | Maximum client tool definitions |
| `ENABLE_EVENT_PROXY` | `false` | Enable authenticated raw OpenCode SSE proxy |
| `CORS_ORIGIN` | empty | Comma-separated allowed origins |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, or `silent` |

## Authentication and lifecycle

- Every route, including `/health`, requires `Authorization: Bearer $API_KEY`.
- `GET /health` is liveness: it checks only worker state and does not contact
  OpenCode.
- `GET /api/health` is readiness: it contacts OpenCode and reports `ready` or
  `not_ready`.
- During graceful shutdown both return `503` with `shutting_down`.
- On `SIGTERM`/`SIGINT` the worker stops accepting prompts, interrupts active
  sessions, waits for in-flight work up to the shutdown timeout, stops OpenCode, and
  exits.
- If OpenCode cannot start, the worker logs `startup_failed`, exits with code `1`,
  and includes recent OpenCode output in the error.

## API

All responses are JSON unless noted. IDs returned by OpenCode are preserved.

### Health and identity

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Worker liveness |
| `GET` | `/api/health` | Worker + OpenCode readiness |
| `GET` | `/api/identity` | Worker identity, protocol, capabilities, prompt hash |
| `GET` | `/api/capabilities` | Alias for identity/capabilities |
| `GET` | `/api/models` | Available models, sanitized |
| `GET` | `/api/models/default` | Default model, sanitized |
| `GET` | `/api/providers` | Providers, sanitized |
| `GET` | `/api/agents` | The fixed `worker` agent only, sanitized |

Provider API keys and agent system prompts/permissions are removed from all
responses.

### Sessions

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/sessions` | List sessions (`limit`, `order`, `cursor`, `search`) |
| `POST` | `/api/sessions` | Create a session |
| `GET` | `/api/sessions/:id` | Get a session |
| `PATCH` | `/api/sessions/:id` | Update `title` and/or `metadata` |
| `DELETE` | `/api/sessions/:id` | Delete a session explicitly |
| `GET` | `/api/sessions/:id/messages` | List messages (`limit`, `order`, `cursor`, `type`) |
| `POST` | `/api/sessions/:id/prompt` | Run a synchronous prompt |
| `POST` | `/api/sessions/:id/interrupt` | Interrupt the active prompt |
| `GET` | `/api/sessions/:id/export` | Export a verified session |
| `POST` | `/api/sessions/import` | Import a session into the worker workspace |
| `GET` | `/api/events` | Optional raw OpenCode SSE proxy |

Session creation body:

```json
{
  "title": "My session",
  "model": "provider/model#variant",
  "metadata": { "tenant": "example" }
}
```

`agent` may be omitted or set to `"worker"`; any other agent is rejected. Sessions
are never deleted automatically.

Import accepts the object returned by export (`info` + `messages`). The worker forces
the import location to `WORKSPACE`, rejects locations outside it, and remaps message
and content-part IDs so importing an export into the same OpenCode database does not
collide. The caller must supply a new, unused `info.id`.

### Prompt

```http
POST /api/sessions/:id/prompt
Authorization: Bearer $API_KEY
Content-Type: application/json

{
  "prompt": "Explain this error and propose a minimal fix.",
  "system": "Optional client instructions, treated as lower-priority context.",
  "context": [
    { "role": "user", "content": "Earlier question" },
    { "role": "assistant", "content": "Earlier answer" },
    { "role": "tool", "content": "Tool result", "toolCallId": "call_1" }
  ],
  "model": "provider/model#variant",
  "tools": [
    {
      "name": "read_file",
      "description": "Read a file through the local agent",
      "parameters": { "type": "object", "properties": { "path": { "type": "string" } } }
    }
  ],
  "toolProtocol": "assistant-json-v1",
  "timeoutMs": 120000
}
```

Fields:

- `prompt` (required): non-empty string.
- `system` / `context` / `messages`: optional client context. These are wrapped in
  lower-priority user-message blocks and never become a system instruction.
- `model`: optional `provider/model` or `provider/model#variant`, or
  `{ "providerID": "...", "id": "...", "variant": "..." }`. The model must be
  available.
- `tools`: optional client tool definitions. They are described to the model; they
  are not installed into OpenCode and are never executed by the worker.
- `toolProtocol`: `assistant-json-v1` (default when tools are present) or `none`.
- `timeoutMs`: optional 1s–30min override.
- `stream` is not supported. Sending `stream: true` returns `400
  streaming_not_supported`.

Successful response:

```json
{
  "protocol": "worker.v1",
  "sessionId": "ses_...",
  "userMessageId": "msg_...",
  "messageId": "msg_...",
  "model": { "providerID": "provider", "id": "model" },
  "agent": "worker",
  "finish": "stop",
  "outcome": "succeeded",
  "type": "message",
  "text": "The final answer",
  "toolCalls": null,
  "toolProtocol": "assistant-json-v1",
  "protocolError": null,
  "parts": [{ "type": "text", "text": "The final answer" }],
  "nativeToolEvents": [],
  "usage": { "input": 10, "output": 20 },
  "cost": 0,
  "durationMs": 1234
}
```

`type` is `text` for a plain response, `message` for a parsed `assistant-json-v1`
final message, and `tool_call` when structured tool calls were parsed.

When `tool_call`, `toolCalls` contains requests only:

```json
{
  "type": "tool_call",
  "toolCalls": [
    {
      "id": "call_...",
      "name": "read_file",
      "arguments": { "path": "src/index.js" },
      "executed": false
    }
  ]
}
```

## Tool protocol (`assistant-json-v1`)

OpenCode 2.2.5 has no verified per-request API for installing arbitrary native tool
definitions. The worker therefore does not claim native model function calling.
Instead, when `tools` are supplied, the user prompt includes a protocol that asks the
model to reply with exactly one JSON object:

```json
{"type":"message","content":"final answer"}
```

or:

```json
{"type":"tool_call","tool_calls":[{"id":"call_1","name":"read_file","arguments":{"path":"src/index.js"}}]}
```

The worker validates the shape, tool name, and arguments. It does not execute the
call and does not invent a result. If the model returns malformed JSON or an unknown
tool, the response still has HTTP 200 but includes `protocolError` with a code such as
`invalid_json`, `unknown_tool`, `invalid_tool_arguments`, `empty_response`, or
`no_tools_available`.

Native OpenCode tool attempts, if a model emits one anyway, appear in
`nativeToolEvents` with `executed: false` and their error status. They are not client
tool calls.

## Error format

Worker and upstream errors use one envelope:

```json
{
  "error": {
    "code": "prompt_failed",
    "message": "Human-readable message",
    "details": {}
  }
}
```

Common statuses:

- `400` invalid request, model, protocol, or session input
- `401` missing/invalid Bearer API key
- `403` session or import location outside `WORKSPACE`
- `404` unknown route or OpenCode session
- `409` session busy, prompt interrupted, or conflicting state
- `413` body/prompt/system too large
- `429` worker prompt concurrency limit
- `499` client aborted the request
- `502` OpenCode failure, provider failure, timeout inside OpenCode
- `503` worker not ready, shutting down, or upstream rate-limited
- `504` request or prompt timeout

Provider failures keep their structured details (for example
`{"type":"provider.free-limit","message":"...","status":429}`).

## Testing

```bash
npm test              # mocked unit/API tests; real integration test is skipped
npm run test:integration
```

- `test/app.test.js`, `test/prompt.test.js`, `test/config.test.js`, and
  `test/process.test.js` use an in-memory fake OpenCode client and test helpers. They
  cover auth, readiness, sanitization, session CRUD, location isolation, prompt
  composition/parsing, concurrency, errors, export/import, and process lifecycle.
- `test/integration.test.js` is gated by `OPENCODE_INTEGRATION=1`. It starts the real
  installed `opencode` server, starts an embedded OpenAI-compatible mock provider,
  and verifies the real fixed prompt prefix, plain and multi-turn responses,
  `assistant-json-v1`, native tool denial with no file created, export/import, and
  no automatic session deletion.

The integration test runs against OpenCode 2.2.5. Newer major versions are rejected;
other 2.x versions start with a warning.

## Limitations and non-goals

- Synchronous prompts only. There is no token streaming endpoint. The optional
  `/api/events` proxy forwards raw OpenCode events and is not reasoning streaming.
- Client tool definitions are a validated JSON prompt protocol, not native function
  calling.
- Client tools are never executed, and tool results cannot be injected as if the
  worker executed them.
- OpenCode appends its own harness context after the fixed system prompt; the worker
  cannot suppress that suffix.
- Model/provider behavior, limits, and errors depend on the configured provider.
- No gateway routing, failover, global session ownership, RepoGrid integration, or
  public OpenAI-compatible endpoints.
- No filesystem editing, shell execution, or project file discovery by the worker.
