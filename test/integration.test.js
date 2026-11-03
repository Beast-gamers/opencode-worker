const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const { createApp } = require("../src/app");
const { loadConfig, ensureRuntimeDirectories } = require("../src/config");
const { createLogger, silentLogger } = require("../src/logger");
const { OpenCodeClient } = require("../src/opencode-client");
const { startOpenCode, stopOpenCode } = require("../src/opencode-process");
const { SYSTEM_PROMPT } = require("../src/system-prompt");

const ENABLED = process.env.OPENCODE_INTEGRATION === "1";
const API_KEY = "integration-api-key";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startMockProvider(t, workspace) {
  const requests = [];

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
    });
    req.on("end", () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }

      requests.push({ url: req.url, body });

      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ id: "mock-model", object: "model" }]
          })
        );
        return;
      }

      if (!req.url.endsWith("/chat/completions")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }

      const messages = body?.messages || [];
      const userText = messages
        .filter(message => message.role === "user")
        .map(message =>
          typeof message.content === "string"
            ? message.content
            : JSON.stringify(message.content)
        )
        .join("\n");

      const nativeTool = userText.includes("NATIVE_TOOL_REQUEST");
      const protocolRequest = userText.includes(
        "TOOL PROTOCOL: assistant-json-v1"
      );

      const text = nativeTool
        ? ""
        : protocolRequest
          ? JSON.stringify({
              type: "tool_call",
              tool_calls: [
                {
                  name: "read_file",
                  arguments: { path: "src/index.js" }
                }
              ]
            })
          : "INTEGRATION_OK";

      const toolCall = {
        id: "call_native_integration",
        type: "function",
        function: {
          name: "write",
          arguments: JSON.stringify({
            filePath: path.join(workspace, "native-tool-created.txt"),
            content: "NATIVE_TOOL_RAN"
          })
        }
      };

      const message = nativeTool
        ? { role: "assistant", content: null, tool_calls: [toolCall] }
        : { role: "assistant", content: text };

      if (body?.stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });

        const base = {
          id: "chatcmpl-integration",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "mock-model"
        };

        if (nativeTool) {
          res.write(
            `data: ${JSON.stringify({
              ...base,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: toolCall.id,
                        type: "function",
                        function: toolCall.function
                      }
                    ]
                  },
                  finish_reason: null
                }
              ]
            })}\n\n`
          );
          res.write(
            `data: ${JSON.stringify({
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }]
            })}\n\n`
          );
        } else {
          res.write(
            `data: ${JSON.stringify({
              ...base,
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: text },
                  finish_reason: null
                }
              ]
            })}\n\n`
          );
          res.write(
            `data: ${JSON.stringify({
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
            })}\n\n`
          );
        }

        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-integration",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "mock-model",
          choices: [
            {
              index: 0,
              message,
              finish_reason: nativeTool ? "tool_calls" : "stop"
            }
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
        })
      );
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      t.after(() => new Promise(done => server.close(done)));
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        requests
      });
    });
  });
}

async function waitForModel(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const response = await request(url, "/api/models");
      last = response;
      if (
        response.status === 200 &&
        response.body.data.some(
          model =>
            model.providerID === "mock" && model.modelID === "mock-model"
        )
      ) {
        return response;
      }
    } catch (error) {
      last = error;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(
    `model mock/mock-model did not become available: ${JSON.stringify(
      last?.body ?? String(last)
    )}`
  );
}

async function request(url, pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.token !== null) {
    headers.authorization = `Bearer ${options.token || API_KEY}`;
  }
  if (options.body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(`${url}${pathname}`, {
    method: options.method || "GET",
    headers,
    body:
      options.body === undefined
        ? undefined
        : typeof options.body === "string"
          ? options.body
          : JSON.stringify(options.body)
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, headers: response.headers, body, text };
}

test(
  "real OpenCode worker integration",
  { skip: ENABLED ? false : "set OPENCODE_INTEGRATION=1 to run" },
  async t => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "worker-integration-home-")
    );
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), "worker-integration-workspace-")
    );
    const cleanup = [];
    t.after(async () => {
      for (const fn of cleanup.reverse()) {
        try {
          await fn();
        } catch {}
      }
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    });

    const mock = await startMockProvider(t, workspace);
    const opencodePort = await freePort();
    const workerPort = await freePort();

    const config = loadConfig({
      API_KEY,
      WORKER_ID: "integration-worker",
      HOME: home,
      WORKSPACE: workspace,
      PORT: String(workerPort),
      OPENCODE_PORT: String(opencodePort),
      OPENCODE_MODEL: "mock/mock-model",
      OPENCODE_START_TIMEOUT_MS: "60000",
      PROMPT_TIMEOUT_MS: "60000",
      REQUEST_TIMEOUT_MS: "30000",
      OPENCODE_EXTRA_CONFIG: JSON.stringify({
        providers: {
          mock: {
            name: "Mock",
            package: "@opencode/ai/providers/openai-compatible",
            settings: { apiKey: "test", baseURL: mock.url },
            models: {
              "mock-model": {
                name: "Mock Model",
                type: "chat",
                limit: { context: 128000, output: 4096 },
                capabilities: {
                  tools: true,
                  input: ["text"],
                  output: ["text"]
                }
              }
            }
          }
        }
      })
    });
    ensureRuntimeDirectories(config);

    const logger = createLogger(process.env.INTEGRATION_DEBUG ? "info" : "silent");
    const opencode = new OpenCodeClient({
      baseUrl: config.opencode.url,
      username: config.opencode.username,
      password: config.opencode.password,
      timeoutMs: config.limits.requestTimeoutMs
    });

    const started = await startOpenCode({ config, client: opencode, logger });
    cleanup.push(() =>
      stopOpenCode(started.process, logger, config.limits.shutdownTimeoutMs)
    );

    const { app } = createApp({ config, opencode, logger: silentLogger });
    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    cleanup.push(() => new Promise(resolve => server.close(resolve)));

    const { port } = server.address();
    const url = `http://127.0.0.1:${port}`;

    await t.test("startup validates the real fixed worker agent", async () => {
      const identity = await request(url, "/api/identity");
      assert.equal(identity.status, 200);

      const agents = await request(url, "/api/agents");
      assert.equal(agents.status, 200);
      assert.deepEqual(
        agents.body.data.map(agent => agent.id),
        ["worker"]
      );
      assert.equal(agents.body.data[0].system, undefined);
      assert.equal(agents.body.data[0].permissions, undefined);

      const models = await waitForModel(url);
      assert.equal(models.status, 200);
      assert.ok(!models.text.includes('"apiKey"'));
    });

    await t.test(
      "plain prompt returns the completed assistant response with the exact system prompt prefix",
      async () => {
        const created = await request(url, "/api/sessions", {
          method: "POST",
          body: { title: "integration plain", model: "mock/mock-model" }
        });
        assert.equal(created.status, 201);
        const sessionID = created.body.data.id;
        assert.match(sessionID, /^ses_/);

        const response = await request(
          url,
          `/api/sessions/${sessionID}/prompt`,
          {
            method: "POST",
            body: {
              prompt: "PLAIN_INTEGRATION_REQUEST",
              system: "CLIENT_SYSTEM_CANARY"
            }
          }
        );

        assert.equal(response.status, 200);
        assert.equal(response.body.sessionId, sessionID);
        assert.equal(response.body.type, "text");
        assert.equal(response.body.text, "INTEGRATION_OK");

        const providerRequest = mock.requests.find(entry =>
          JSON.stringify(entry.body || {}).includes("PLAIN_INTEGRATION_REQUEST")
        );
        assert.ok(providerRequest, "expected a provider request");
        const messages = providerRequest.body.messages || [];
        const systemMessage = messages.find(message => message.role === "system");
        const userMessage = messages.find(message =>
          JSON.stringify(message.content).includes("PLAIN_INTEGRATION_REQUEST")
        );

        assert.ok(systemMessage, "expected a system message");
        assert.ok(
          systemMessage.content.startsWith(SYSTEM_PROMPT),
          "the configured system prompt must be first"
        );
        assert.ok(
          !systemMessage.content.includes("CLIENT_SYSTEM_CANARY"),
          "client system content must never enter the system slot"
        );
        assert.ok(userMessage);
        assert.match(JSON.stringify(userMessage.content), /CLIENT_SYSTEM_CANARY/);
        assert.match(
          JSON.stringify(userMessage.content),
          /LOWER PRIORITY than your system instructions/
        );

        const fetched = await request(url, `/api/sessions/${sessionID}`);
        assert.equal(fetched.status, 200);
        assert.equal(fetched.body.data.id, sessionID);
        assert.equal(fetched.body.data.agent, "worker");

        const messagesResponse = await request(
          url,
          `/api/sessions/${sessionID}/messages?order=asc`
        );
        assert.equal(messagesResponse.status, 200);
        assert.ok(
          messagesResponse.body.data.some(message => message.type === "user")
        );
        assert.ok(
          messagesResponse.body.data.some(
            message => message.type === "assistant"
          )
        );

        t.diagnostic(`plain session ${sessionID}`);
      }
    );

    await t.test(
      "assistant-json-v1 returns a structured tool request without executing it",
      async () => {
        const created = await request(url, "/api/sessions", {
          method: "POST",
          body: { title: "integration tool protocol" }
        });
        const sessionID = created.body.data.id;
        const marker = path.join(workspace, "protocol-tool-marker.txt");

        const response = await request(url, `/api/sessions/${sessionID}/prompt`, {
          method: "POST",
          body: {
            prompt: "PROTOCOL_INTEGRATION_REQUEST",
            tools: [
              {
                name: "read_file",
                description: "Read a file through the local agent",
                parameters: {
                  type: "object",
                  properties: { path: { type: "string" } },
                  required: ["path"]
                }
              }
            ]
          }
        });

        assert.equal(response.status, 200);
        assert.equal(response.body.type, "tool_call");
        assert.equal(response.body.toolProtocol, "assistant-json-v1");
        assert.equal(response.body.toolCalls.length, 1);
        assert.equal(response.body.toolCalls[0].name, "read_file");
        assert.deepEqual(response.body.toolCalls[0].arguments, {
          path: "src/index.js"
        });
        assert.equal(response.body.toolCalls[0].executed, false);
        assert.equal(fs.existsSync(marker), false);
      }
    );

    await t.test(
      "native OpenCode tool attempts are denied and create no files",
      async () => {
        const created = await request(url, "/api/sessions", {
          method: "POST",
          body: { title: "integration native tool denial" }
        });
        const sessionID = created.body.data.id;
        const target = path.join(workspace, "native-tool-created.txt");

        assert.equal(fs.existsSync(target), false);

        const response = await request(url, `/api/sessions/${sessionID}/prompt`, {
          method: "POST",
          body: { prompt: "NATIVE_TOOL_REQUEST" }
        });

        assert.equal(response.status, 200);
        assert.equal(response.body.toolCalls, null);
        assert.ok(response.body.nativeToolEvents.length >= 1);
        const writeEvent = response.body.nativeToolEvents.find(
          event => event.name === "write"
        );
        assert.ok(writeEvent, "expected a native write attempt");
        assert.equal(writeEvent.executed, false);
        assert.equal(writeEvent.status, "error");
        assert.equal(fs.existsSync(target), false);
      }
    );

    await t.test(
      "sessions are not deleted automatically and export/import round-trips",
      async () => {
        const created = await request(url, "/api/sessions", {
          method: "POST",
          body: { title: "integration export" }
        });
        const sessionID = created.body.data.id;

        const prompt = await request(url, `/api/sessions/${sessionID}/prompt`, {
          method: "POST",
          body: { prompt: "EXPORT_INTEGRATION_REQUEST" }
        });
        assert.equal(prompt.status, 200);

        const stillThere = await request(url, `/api/sessions/${sessionID}`);
        assert.equal(stillThere.status, 200);

        const list = await request(url, "/api/sessions?limit=200");
        assert.equal(list.status, 200);
        assert.ok(
          list.body.data.some(session => session.id === sessionID),
          "the session must not be deleted automatically"
        );

        const exported = await request(
          url,
          `/api/sessions/${sessionID}/export`
        );
        assert.equal(exported.status, 200);
        assert.equal(exported.body.data.info.id, sessionID);
        assert.ok(exported.body.data.messages.length > 0);

        const importedID = `${sessionID}_imported`;
        const imported = await request(url, "/api/sessions/import", {
          method: "POST",
          body: {
            info: {
              ...exported.body.data.info,
              id: importedID,
              title: "imported integration"
            },
            messages: exported.body.data.messages
          }
        });
        assert.equal(
          imported.status,
          201,
          `import failed: ${JSON.stringify(imported.body)}`
        );
        assert.equal(imported.body.data.id, importedID);
        assert.deepEqual(imported.body.data.location, { directory: workspace });

        const importedGet = await request(url, `/api/sessions/${importedID}`);
        assert.equal(importedGet.status, 200);
        assert.equal(importedGet.body.data.title, "imported integration");

        const originalStillThere = await request(
          url,
          `/api/sessions/${sessionID}`
        );
        assert.equal(originalStillThere.status, 200);
      }
    );

    await t.test("session ids remain native and multi-turn sessions continue", async () => {
      const created = await request(url, "/api/sessions", {
        method: "POST",
        body: { title: "integration multi-turn" }
      });
      const sessionID = created.body.data.id;

      const first = await request(url, `/api/sessions/${sessionID}/prompt`, {
        method: "POST",
        body: { prompt: "TURN_ONE" }
      });
      assert.equal(first.status, 200);
      assert.equal(first.body.text, "INTEGRATION_OK");

      const second = await request(url, `/api/sessions/${sessionID}/prompt`, {
        method: "POST",
        body: { prompt: "TURN_TWO" }
      });
      assert.equal(second.status, 200);
      assert.equal(second.body.text, "INTEGRATION_OK");
      assert.equal(second.body.sessionId, sessionID);

      const messages = await request(
        url,
        `/api/sessions/${sessionID}/messages?order=asc`
      );
      assert.equal(messages.status, 200);
      assert.equal(
        messages.body.data.filter(message => message.type === "user").length,
        2
      );
    });
  }
);

test("integration helper is gated", () => {
  assert.equal(typeof ENABLED, "boolean");
});
