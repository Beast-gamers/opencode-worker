const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createApp } = require("../src/app");
const { silentLogger } = require("../src/logger");
const { OpenCodeError } = require("../src/errors");
const { SYSTEM_PROMPT_SHA256 } = require("../src/system-prompt");
const { FakeOpenCode } = require("./helpers/fake-opencode");

const API_KEY = "test-api-key-1234567890";

function makeConfig(overrides = {}) {
  return {
    apiKey: API_KEY,
    workerId: "test-worker",
    workerName: "test-worker",
    workerVersion: "1.0.0",
    port: 0,
    opencodePort: 4100,
    host: "127.0.0.1",
    home: "/tmp/test-home",
    workspace: "/tmp/test-workspace",
    opencode: {
      bin: "opencode",
      hostname: "127.0.0.1",
      username: "opencode",
      password: "test-password",
      url: "http://127.0.0.1:4100",
      model: null,
      extraConfig: {}
    },
    limits: {
      maxConcurrentPrompts: 2,
      promptTimeoutMs: 5000,
      requestTimeoutMs: 2000,
      startupTimeoutMs: 5000,
      shutdownTimeoutMs: 1000,
      bodyLimit: "1mb",
      maxContextMessages: 10,
      maxTools: 5
    },
    enableEventProxy: false,
    corsOrigins: [],
    logLevel: "silent",
    ...overrides
  };
}

async function startApp(options = {}) {
  const config = makeConfig(options.config);
  const fake =
    options.fake ||
    new FakeOpenCode({ workspace: config.workspace, ...options.fakeOptions });
  fake.workspace = config.workspace;
  const { app, state } = createApp({
    config,
    opencode: fake,
    logger: silentLogger,
    promptRunner: options.promptRunner
  });

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;

  return {
    fake,
    config,
    state,
    url,
    server,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

async function request(url, path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = options.token === undefined ? API_KEY : options.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(`${url}${path}`, {
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

async function createSession(app, body = {}) {
  const response = await request(app.url, "/api/sessions", {
    method: "POST",
    body
  });
  assert.equal(response.status, 201);
  return response.body.data;
}

test("liveness and readiness are authenticated", async t => {
  const app = await startApp();
  t.after(() => app.close());

  const unauthenticatedLive = await request(app.url, "/health", { token: null });
  assert.equal(unauthenticatedLive.status, 401);

  const live = await request(app.url, "/health");
  assert.equal(live.status, 200);
  assert.equal(live.body.status, "ok");
  assert.equal(live.body.workerId, "test-worker");

  const unauthorized = await request(app.url, "/api/health", { token: null });
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.body.error.code, "unauthorized");

  const ready = await request(app.url, "/api/health");
  assert.equal(ready.status, 200);
  assert.equal(ready.body.status, "ready");
  assert.equal(ready.body.opencode.version, "2.2.5");

  const broken = await startApp({
    fake: new FakeOpenCode({
      infoError: new OpenCodeError("down", {
        status: 502,
        code: "upstream_unavailable"
      })
    })
  });
  t.after(() => broken.close());

  const notReady = await request(broken.url, "/api/health");
  assert.equal(notReady.status, 503);
  assert.equal(notReady.body.status, "not_ready");
  assert.equal(notReady.body.opencode.ready, false);
});

test("identity advertises the fixed prompt and honest capability flags", async t => {
  const app = await startApp();
  t.after(() => app.close());

  const response = await request(app.url, "/api/identity");
  assert.equal(response.status, 200);
  assert.equal(response.body.worker.id, "test-worker");
  assert.equal(response.body.systemPrompt.sha256, SYSTEM_PROMPT_SHA256);
  assert.equal(response.body.systemPrompt.enforced, true);
  assert.equal(response.body.systemPrompt.clientSystemInstructions, "lower-priority-context-only");
  assert.equal(response.body.protocol.streaming, false);
  assert.equal(response.body.capabilities.streaming, false);
  assert.equal(response.body.capabilities.nativeClientToolExecution, false);
  assert.equal(response.body.capabilities.filesystemAccess, false);
  assert.equal(response.body.capabilities.shellExecution, false);
  assert.equal(response.body.capabilities.projectFileDiscovery, false);
  assert.equal(response.body.capabilities.structuredToolCalls, "assistant-json-v1");
  assert.equal(response.body.capabilities.automaticSessionDeletion, false);
  assert.ok(!response.text.includes("You are a remote LLM reasoning worker"));

  const alias = await request(app.url, "/api/capabilities");
  assert.equal(alias.status, 200);
  assert.deepEqual(alias.body.capabilities, response.body.capabilities);
});

test("models, providers, and agents are sanitized", async t => {
  const app = await startApp();
  t.after(() => app.close());

  const models = await request(app.url, "/api/models");
  assert.equal(models.status, 200);
  assert.equal(models.body.data[0].providerID, "mock");
  assert.equal(models.body.data[0].settings, undefined);
  assert.ok(!models.text.includes("provider-secret"));

  const providers = await request(app.url, "/api/providers");
  assert.equal(providers.status, 200);
  assert.equal(providers.body.data[0].id, "mock");
  assert.equal(providers.body.data[0].settings, undefined);
  assert.ok(!providers.text.includes("provider-secret"));

  const agents = await request(app.url, "/api/agents");
  assert.equal(agents.status, 200);
  assert.equal(agents.body.data.length, 1);
  assert.equal(agents.body.data[0].id, "worker");
  assert.equal(agents.body.data[0].system, undefined);
  assert.equal(agents.body.data[0].permissions, undefined);
  assert.ok(!agents.text.includes("You are a remote LLM reasoning worker"));
  assert.ok(!agents.text.includes("build prompt"));

  const defaultModel = await request(app.url, "/api/models/default");
  assert.equal(defaultModel.status, 200);
  assert.equal(defaultModel.body.data.id, "mock-model");
  assert.equal(defaultModel.body.data.settings, undefined);
});

test("session CRUD keeps native ids and forces the worker agent", async t => {
  const app = await startApp();
  t.after(() => app.close());

  const created = await request(app.url, "/api/sessions", {
    method: "POST",
    body: { title: "My Session" }
  });
  assert.equal(created.status, 201);
  assert.match(created.body.data.id, /^ses_/);
  assert.equal(created.body.data.agent, "worker");
  assert.equal(created.body.data.title, "My Session");

  const rejectedAgent = await request(app.url, "/api/sessions", {
    method: "POST",
    body: { agent: "build" }
  });
  assert.equal(rejectedAgent.status, 400);
  assert.equal(rejectedAgent.body.error.code, "agent_not_allowed");

  const unknownModel = await request(app.url, "/api/sessions", {
    method: "POST",
    body: { model: { providerID: "mock", id: "missing" } }
  });
  assert.equal(unknownModel.status, 400);
  assert.equal(unknownModel.body.error.code, "model_not_available");

  const selectedModel = await request(app.url, "/api/sessions", {
    method: "POST",
    body: { model: { providerID: "mock", id: "mock-model", variant: "low" } }
  });
  assert.equal(selectedModel.status, 201);
  assert.deepEqual(selectedModel.body.data.model, {
    providerID: "mock",
    id: "mock-model",
    variant: "low"
  });

  const list = await request(app.url, "/api/sessions");
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 2);
  assert.deepEqual(list.body.cursor, { previous: null, next: null });

  const sessionID = created.body.data.id;
  const got = await request(app.url, `/api/sessions/${sessionID}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.data.id, sessionID);

  const patched = await request(app.url, `/api/sessions/${sessionID}`, {
    method: "PATCH",
    body: { title: "Renamed" }
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.data.title, "Renamed");

  const deleted = await request(app.url, `/api/sessions/${sessionID}`, {
    method: "DELETE"
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deleted, true);

  const missing = await request(app.url, `/api/sessions/${sessionID}`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "SessionNotFoundError");
});

test("sessions outside the worker workspace are rejected", async t => {
  const fake = new FakeOpenCode();
  const app = await startApp({ fake });
  t.after(() => app.close());

  const session = await fake.createSession({ title: "outside" });
  session.data.location = { directory: "/tmp/other-workspace" };

  const got = await request(app.url, `/api/sessions/${session.data.id}`);
  assert.equal(got.status, 403);
  assert.equal(got.body.error.code, "session_location_not_allowed");

  const prompt = await request(app.url, `/api/sessions/${session.data.id}/prompt`, {
    method: "POST",
    body: { prompt: "hello" }
  });
  assert.equal(prompt.status, 403);

  const messages = await request(
    app.url,
    `/api/sessions/${session.data.id}/messages`
  );
  assert.equal(messages.status, 403);

  const exported = await request(
    app.url,
    `/api/sessions/${session.data.id}/export`
  );
  assert.equal(exported.status, 403);
});

test("synchronous prompt returns the completed assistant response and supports multi-turn sessions", async t => {
  const fake = new FakeOpenCode({
    promptResults: [{ text: "first answer" }, { text: "second answer" }]
  });
  const app = await startApp({ fake });
  t.after(() => app.close());

  const session = await createSession(app);

  const first = await request(app.url, `/api/sessions/${session.id}/prompt`, {
    method: "POST",
    body: { prompt: "first question" }
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.sessionId, session.id);
  assert.equal(first.body.text, "first answer");
  assert.equal(first.body.type, "text");
  assert.equal(first.body.toolCalls, null);
  assert.equal(first.body.outcome, "succeeded");
  assert.match(first.body.messageId, /^msg_/);
  assert.equal(first.body.nativeToolEvents.length, 0);

  const second = await request(app.url, `/api/sessions/${session.id}/prompt`, {
    method: "POST",
    body: { prompt: "second question" }
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.sessionId, session.id);
  assert.equal(second.body.text, "second answer");

  assert.equal(fake.deletedSessions.length, 0);
  assert.ok(fake.sessions.has(session.id));

  const messages = await request(
    app.url,
    `/api/sessions/${session.id}/messages?order=asc`
  );
  assert.equal(messages.status, 200);
  assert.equal(messages.body.data.filter(message => message.type === "user").length, 2);
  assert.equal(messages.body.data.filter(message => message.type === "assistant").length, 2);
});

test("prompt validation rejects unsafe or unsupported input", async t => {
  const app = await startApp();
  t.after(() => app.close());

  const session = await createSession(app);
  const endpoint = `/api/sessions/${session.id}/prompt`;

  const missingPrompt = await request(app.url, endpoint, {
    method: "POST",
    body: {}
  });
  assert.equal(missingPrompt.status, 400);
  assert.equal(missingPrompt.body.error.code, "invalid_prompt");

  const stream = await request(app.url, endpoint, {
    method: "POST",
    body: { prompt: "hello", stream: true }
  });
  assert.equal(stream.status, 400);
  assert.equal(stream.body.error.code, "streaming_not_supported");

  const agent = await request(app.url, endpoint, {
    method: "POST",
    body: { prompt: "hello", agent: "build" }
  });
  assert.equal(agent.status, 400);
  assert.equal(agent.body.error.code, "agent_not_allowed");

  const invalidModel = await request(app.url, endpoint, {
    method: "POST",
    body: { prompt: "hello", model: "not-a-model" }
  });
  assert.equal(invalidModel.status, 400);
  assert.equal(invalidModel.body.error.code, "invalid_model");

  const unknownModel = await request(app.url, endpoint, {
    method: "POST",
    body: { prompt: "hello", model: "mock/missing" }
  });
  assert.equal(unknownModel.status, 400);
  assert.equal(unknownModel.body.error.code, "model_not_available");

  const tooMuchContext = await request(app.url, endpoint, {
    method: "POST",
    body: {
      prompt: "hello",
      context: Array.from({ length: 11 }, () => ({
        role: "user",
        content: "context"
      }))
    }
  });
  assert.equal(tooMuchContext.status, 400);
  assert.equal(tooMuchContext.body.error.code, "too_many_context_messages");

  const tooManyTools = await request(app.url, endpoint, {
    method: "POST",
    body: {
      prompt: "hello",
      tools: Array.from({ length: 6 }, (_, index) => ({
        name: `tool-${index}`
      }))
    }
  });
  assert.equal(tooManyTools.status, 400);
  assert.equal(tooManyTools.body.error.code, "too_many_tools");

  const badProtocol = await request(app.url, endpoint, {
    method: "POST",
    body: { prompt: "hello", toolProtocol: "native" }
  });
  assert.equal(badProtocol.status, 400);
  assert.equal(badProtocol.body.error.code, "invalid_tool_protocol");

  const badTimeout = await request(app.url, endpoint, {
    method: "POST",
    body: { prompt: "hello", timeoutMs: 10 }
  });
  assert.equal(badTimeout.status, 400);
  assert.equal(badTimeout.body.error.code, "invalid_timeout");

  const missingSession = await request(app.url, "/api/sessions/ses_missing/prompt", {
    method: "POST",
    body: { prompt: "hello" }
  });
  assert.equal(missingSession.status, 404);
  assert.equal(missingSession.body.error.code, "SessionNotFoundError");
});

test("prompt failures and interruptions are propagated", async t => {
  const fake = new FakeOpenCode({
    promptResults: [
      {
        outcome: "failed",
        idleError: {
          type: "provider.free-limit",
          message: "Free usage limit reached",
          status: 429,
          retryAfterMs: 1000
        }
      },
      { outcome: "interrupted" },
      {
        text: "assistant error",
        finish: "error",
        error: { type: "provider.transport", message: "transport failed" }
      }
    ]
  });
  const app = await startApp({ fake });
  t.after(() => app.close());

  const session = await createSession(app);
  const endpoint = `/api/sessions/${session.id}/prompt`;

  const failed = await request(app.url, endpoint, {
    method: "POST",
    body: { prompt: "fail" }
  });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error.code, "prompt_failed");
  assert.equal(failed.body.error.details.error.type, "provider.free-limit");

  const interrupted = await request(app.url, endpoint, {
    method: "POST",
    body: { prompt: "interrupt" }
  });
  assert.equal(interrupted.status, 409);
  assert.equal(interrupted.body.error.code, "prompt_interrupted");

  const assistantError = await request(app.url, endpoint, {
    method: "POST",
    body: { prompt: "assistant error" }
  });
  assert.equal(assistantError.status, 502);
  assert.equal(assistantError.body.error.code, "prompt_failed");
  assert.equal(assistantError.body.error.details.error.type, "provider.transport");
});

test("native OpenCode tool activity is reported separately and never returned as client tool calls", async t => {
  const fake = new FakeOpenCode({
    promptResults: [
      {
        nativeTool: {
          name: "write",
          arguments: { filePath: "/tmp/should-not-exist", content: "x" }
        },
        text: "I could not write the file."
      }
    ]
  });
  const app = await startApp({ fake });
  t.after(() => app.close());

  const session = await createSession(app);
  const response = await request(app.url, `/api/sessions/${session.id}/prompt`, {
    method: "POST",
    body: { prompt: "please write" }
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.text, "I could not write the file.");
  assert.equal(response.body.toolCalls, null);
  assert.equal(response.body.nativeToolEvents.length, 1);
  assert.equal(response.body.nativeToolEvents[0].name, "write");
  assert.equal(response.body.nativeToolEvents[0].executed, false);
  assert.equal(response.body.nativeToolEvents[0].status, "error");
});

test("assistant-json-v1 returns structured tool requests without executing them", async t => {
  const fake = new FakeOpenCode({
    promptResults: [
      {
        text: JSON.stringify({
          type: "tool_call",
          tool_calls: [
            {
              name: "read_file",
              arguments: { path: "src/index.js" }
            }
          ]
        })
      },
      {
        text: JSON.stringify({
          type: "tool_call",
          tool_calls: [{ name: "write_file", arguments: { path: "x" } }]
        })
      },
      {
        text: JSON.stringify({ type: "message", content: "final answer" })
      }
    ]
  });
  const app = await startApp({ fake });
  t.after(() => app.close());

  const session = await createSession(app);
  const endpoint = `/api/sessions/${session.id}/prompt`;
  const tools = [
    {
      name: "read_file",
      description: "Read a file through the local agent",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      }
    }
  ];

  const toolRequest = await request(app.url, endpoint, {
    method: "POST",
    body: { prompt: "read it", tools }
  });
  assert.equal(toolRequest.status, 200);
  assert.equal(toolRequest.body.type, "tool_call");
  assert.equal(toolRequest.body.toolProtocol, "assistant-json-v1");
  assert.equal(toolRequest.body.toolCalls.length, 1);
  assert.equal(toolRequest.body.toolCalls[0].name, "read_file");
  assert.deepEqual(toolRequest.body.toolCalls[0].arguments, {
    path: "src/index.js"
  });
  assert.equal(toolRequest.body.toolCalls[0].executed, false);
  assert.match(toolRequest.body.toolCalls[0].id, /^call_/);

  const unknownTool = await request(app.url, endpoint, {
    method: "POST",
    body: { prompt: "write it", tools }
  });
  assert.equal(unknownTool.status, 200);
  assert.equal(unknownTool.body.type, "text");
  assert.equal(unknownTool.body.toolCalls, null);
  assert.equal(unknownTool.body.protocolError.code, "unknown_tool");
  assert.equal(unknownTool.body.protocolError.tool, "write_file");

  const protocolDisabled = await request(app.url, endpoint, {
    method: "POST",
    body: { prompt: "message", tools, toolProtocol: "none" }
  });
  assert.equal(protocolDisabled.status, 200);
  assert.equal(protocolDisabled.body.type, "text");
  assert.equal(protocolDisabled.body.toolCalls, null);
  assert.equal(protocolDisabled.body.toolProtocol, null);
});

test("interrupt, export, and import are available", async t => {
  const fake = new FakeOpenCode({ promptResults: [{ text: "exported" }] });
  const app = await startApp({ fake });
  t.after(() => app.close());

  const session = await createSession(app);

  const interrupt = await request(
    app.url,
    `/api/sessions/${session.id}/interrupt`,
    { method: "POST" }
  );
  assert.equal(interrupt.status, 200);
  assert.equal(interrupt.body.interrupted, true);
  assert.equal(fake.interruptCalls, 1);

  await request(app.url, `/api/sessions/${session.id}/prompt`, {
    method: "POST",
    body: { prompt: "export me" }
  });

  const exported = await request(
    app.url,
    `/api/sessions/${session.id}/export`
  );
  assert.equal(exported.status, 200);
  assert.equal(exported.body.data.info.id, session.id);
  assert.ok(exported.body.data.messages.length > 0);

  const imported = await request(app.url, "/api/sessions/import", {
    method: "POST",
    body: {
      info: { ...exported.body.data.info, id: "ses_imported", title: "Imported" },
      messages: exported.body.data.messages
    }
  });
  assert.equal(imported.status, 201);
  assert.equal(imported.body.data.id, "ses_imported");
  assert.deepEqual(imported.body.data.location, {
    directory: "/tmp/test-workspace"
  });

  const fetched = await request(app.url, "/api/sessions/ses_imported");
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.data.title, "Imported");

  const outsideImport = await request(app.url, "/api/sessions/import", {
    method: "POST",
    body: {
      info: { id: "ses_outside" },
      messages: [],
      location: { directory: "/tmp/other-workspace" }
    }
  });
  assert.equal(outsideImport.status, 403);
  assert.equal(outsideImport.body.error.code, "session_location_not_allowed");

  const outsideInfoImport = await request(app.url, "/api/sessions/import", {
    method: "POST",
    body: {
      info: {
        id: "ses_outside_2",
        location: { directory: "/tmp/other-workspace" }
      },
      messages: []
    }
  });
  assert.equal(outsideInfoImport.status, 403);
});

test("event proxy is disabled by default and can be enabled", async t => {
  const disabled = await startApp();
  t.after(() => disabled.close());

  const unavailable = await request(disabled.url, "/api/events");
  assert.equal(unavailable.status, 404);
  assert.equal(unavailable.body.error.code, "event_proxy_disabled");

  const enabled = await startApp({
    config: { enableEventProxy: true }
  });
  t.after(() => enabled.close());

  const stream = await request(enabled.url, "/api/events");
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type"), /text\/event-stream/);
});

test("unknown routes and malformed JSON return the worker error envelope", async t => {
  const app = await startApp();
  t.after(() => app.close());

  const missing = await request(app.url, "/api/nope");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "not_found");

  const invalidJson = await request(app.url, "/api/sessions", {
    method: "POST",
    body: "{",
    headers: { "content-type": "application/json" }
  });
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.body.error.code, "invalid_json");

  const wrongKey = await request(app.url, "/api/health", {
    token: "wrong-key"
  });
  assert.equal(wrongKey.status, 401);
  assert.match(wrongKey.headers.get("www-authenticate"), /Bearer/);
});

test("per-session and global concurrency limits are enforced", async t => {
  const sameSession = await startApp({
    config: { limits: { ...makeConfig().limits, maxConcurrentPrompts: 2 } },
    promptRunner: async () => {
      sameSession.entered();
      await sameSession.hold;
      return { ok: true };
    }
  });

  let enteredResolve;
  let releaseResolve;
  sameSession.entered = () => enteredResolve();
  sameSession.hold = new Promise(resolve => {
    releaseResolve = resolve;
  });
  const entered = new Promise(resolve => {
    enteredResolve = resolve;
  });

  const session = await createSession(sameSession);
  const first = request(sameSession.url, `/api/sessions/${session.id}/prompt`, {
    method: "POST",
    body: { prompt: "first" }
  });
  await entered;

  const second = await request(
    sameSession.url,
    `/api/sessions/${session.id}/prompt`,
    { method: "POST", body: { prompt: "second" } }
  );
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, "session_busy");

  releaseResolve();
  assert.equal((await first).status, 200);
  await sameSession.close();

  let globalEnteredResolve;
  let globalReleaseResolve;
  const globalEntered = new Promise(resolve => {
    globalEnteredResolve = resolve;
  });
  const globalHold = new Promise(resolve => {
    globalReleaseResolve = resolve;
  });

  const globalApp = await startApp({
    config: { limits: { ...makeConfig().limits, maxConcurrentPrompts: 1 } },
    promptRunner: async () => {
      globalEnteredResolve();
      await globalHold;
      return { ok: true };
    }
  });

  const firstSession = await createSession(globalApp);
  const secondSession = await createSession(globalApp);

  const globalFirst = request(
    globalApp.url,
    `/api/sessions/${firstSession.id}/prompt`,
    { method: "POST", body: { prompt: "first" } }
  );
  await globalEntered;

  const globalSecond = await request(
    globalApp.url,
    `/api/sessions/${secondSession.id}/prompt`,
    { method: "POST", body: { prompt: "second" } }
  );
  assert.equal(globalSecond.status, 429);
  assert.equal(globalSecond.body.error.code, "worker_busy");
  assert.equal(globalSecond.headers.get("retry-after"), "1");

  globalReleaseResolve();
  assert.equal((await globalFirst).status, 200);
  await globalApp.close();
});

test("shutting-down state rejects readiness and new prompts", async t => {
  const app = await startApp();
  t.after(() => app.close());

  const session = await createSession(app);
  app.state.shuttingDown = true;

  const live = await request(app.url, "/health");
  assert.equal(live.status, 503);
  assert.equal(live.body.status, "shutting_down");

  const ready = await request(app.url, "/api/health");
  assert.equal(ready.status, 503);

  const prompt = await request(app.url, `/api/sessions/${session.id}/prompt`, {
    method: "POST",
    body: { prompt: "hello" }
  });
  assert.equal(prompt.status, 503);
  assert.equal(prompt.body.error.code, "worker_shutting_down");
});
