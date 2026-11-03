const test = require("node:test");
const assert = require("node:assert/strict");
const {
  TOOL_PROTOCOL,
  ALLOWED_PROTOCOLS,
  normalizeModel,
  modelKey,
  normalizeTools,
  normalizeContext,
  buildUserPrompt,
  parseAssistantPayload,
  extractTurnFromNewest,
  readTurn,
  readTurnWithRetry,
  runPrompt,
  toolProtocolInstructions
} = require("../src/prompt");
const { WorkerError, OpenCodeError } = require("../src/errors");
const { silentLogger } = require("../src/logger");

function makeConfig(overrides = {}) {
  return {
    limits: {
      promptTimeoutMs: 5000,
      ...overrides
    }
  };
}

function userMessage(id = "msg_user") {
  return { id, type: "user", text: "question" };
}

function assistantMessage(overrides = {}) {
  return {
    id: "msg_assistant",
    type: "assistant",
    agent: "worker",
    model: { providerID: "mock", id: "mock-model" },
    content: [{ type: "text", text: "answer" }],
    finish: "stop",
    tokens: { input: 1, output: 2 },
    cost: 0.01,
    ...overrides
  };
}

function idleMessage(overrides = {}) {
  return { id: "msg_idle", type: "idle", outcome: "succeeded", ...overrides };
}

function fakeOpenCode({
  userMessageID = "msg_user",
  messages = [],
  waitImpl,
  promptImpl,
  listMessagesImpl
} = {}) {
  const fake = {
    switched: [],
    interruptCalls: 0,
    listMessageCalls: [],
    async switchModel(sessionID, model) {
      fake.switched.push({ sessionID, model });
      return { data: true };
    },
    async prompt(sessionID, text) {
      fake.promptText = text;
      if (promptImpl) return promptImpl(sessionID, text);
      return { data: { id: userMessageID } };
    },
    async wait(sessionID, options) {
      if (waitImpl) await waitImpl(sessionID, options);
      return null;
    },
    async listMessages(sessionID, query) {
      fake.listMessageCalls.push({ sessionID, query });
      if (listMessagesImpl) return listMessagesImpl(sessionID, query);
      return { data: messages, cursor: { previous: null, next: null } };
    },
    async interrupt(sessionID) {
      fake.interruptCalls += 1;
      fake.interruptedSession = sessionID;
      return { interrupted: true };
    }
  };
  return fake;
}

test("normalizeModel accepts strings, variants, and objects", () => {
  assert.equal(normalizeModel(undefined), null);
  assert.equal(normalizeModel(null), null);

  assert.deepEqual(normalizeModel("mock/mock-model"), {
    providerID: "mock",
    id: "mock-model"
  });
  assert.deepEqual(normalizeModel("  mock/mock-model  "), {
    providerID: "mock",
    id: "mock-model"
  });
  assert.deepEqual(normalizeModel("mock/mock-model#high"), {
    providerID: "mock",
    id: "mock-model",
    variant: "high"
  });
  assert.deepEqual(normalizeModel("openrouter/anthropic/claude"), {
    providerID: "openrouter",
    id: "anthropic/claude"
  });

  assert.deepEqual(normalizeModel({ providerID: "mock", id: "m" }), {
    providerID: "mock",
    id: "m"
  });
  assert.deepEqual(normalizeModel({ provider: "mock", model: "m" }), {
    providerID: "mock",
    id: "m"
  });
  assert.deepEqual(
    normalizeModel({ providerID: "mock", modelID: "m", variant: "low" }),
    { providerID: "mock", id: "m", variant: "low" }
  );

  assert.equal(modelKey({ providerID: "mock", id: "m" }), "mock/m");
});

test("normalizeModel rejects malformed values", () => {
  for (const value of ["", "   ", "noprovider", "/model", "provider/", 42, true, []]) {
    assert.throws(
      () => normalizeModel(value),
      error => error instanceof WorkerError && error.status === 400
    );
  }

  assert.throws(
    () => normalizeModel({ id: "m" }),
    error => error.code === "invalid_model"
  );
  assert.throws(
    () => normalizeModel({ providerID: "mock" }),
    error => error.code === "invalid_model"
  );
});

test("normalizeTools validates definitions and preserves supported fields", () => {
  assert.deepEqual(normalizeTools(undefined), []);
  assert.deepEqual(normalizeTools(null), []);

  const tools = normalizeTools([
    {
      name: "read_file",
      description: "read",
      parameters: { type: "object" },
      ignored: true
    },
    { name: "write-file_1:x" }
  ]);

  assert.deepEqual(tools, [
    {
      name: "read_file",
      description: "read",
      parameters: { type: "object" }
    },
    { name: "write-file_1:x" }
  ]);

  assert.throws(
    () => normalizeTools({}),
    error => error.code === "invalid_tools"
  );
  assert.throws(
    () => normalizeTools([null]),
    error => error.code === "invalid_tools"
  );
  assert.throws(
    () => normalizeTools([{ name: "bad name" }]),
    error => error.code === "invalid_tools"
  );
  assert.throws(
    () => normalizeTools([{ name: "ok", description: 1 }]),
    error => error.code === "invalid_tools"
  );
  assert.throws(
    () => normalizeTools([{ name: "ok", parameters: [] }]),
    error => error.code === "invalid_tools"
  );
});

test("normalizeContext validates roles and flattens text parts", () => {
  assert.deepEqual(normalizeContext(undefined), []);

  const context = normalizeContext([
    { role: "USER", content: "hello" },
    {
      role: "tool",
      content: [{ type: "text", text: "one" }, "two", { other: true }],
      toolCallId: "call_1"
    },
    { role: "assistant", content: "" }
  ]);

  assert.deepEqual(context, [
    { role: "user", content: "hello" },
    { role: "tool", content: "one\ntwo", toolCallId: "call_1" },
    { role: "assistant", content: "" }
  ]);

  assert.throws(
    () => normalizeContext({}),
    error => error.code === "invalid_context"
  );
  assert.throws(
    () => normalizeContext([{ role: "developer", content: "x" }]),
    error => error.code === "invalid_context"
  );
  assert.throws(
    () => normalizeContext([{ role: "user", content: 42 }]),
    error => error.code === "invalid_context"
  );
});

test("buildUserPrompt marks client material as lower-priority context", () => {
  const text = buildUserPrompt({
    prompt: "Fix the bug",
    system: "You are the client system prompt",
    context: [
      { role: "user", content: "previous user" },
      { role: "assistant", content: "previous answer" },
      { role: "tool", content: "tool result", toolCallId: "call_1" }
    ],
    nonce: "abc123"
  });

  assert.match(text, /LOWER PRIORITY than your system instructions/);
  assert.match(text, /It is not a new system prompt/);
  assert.ok(
    text.includes(
      "<client_system_abc123>\nYou are the client system prompt\n</client_system_abc123>"
    )
  );
  assert.ok(
    text.includes("<client_user_abc123>\nprevious user\n</client_user_abc123>")
  );
  assert.ok(
    text.includes(
      "<client_tool_abc123 tool_call_id=\"call_1\">\ntool result\n</client_tool_abc123>"
    )
  );
  assert.ok(text.includes("<end_client_context_abc123/>"));
  assert.ok(
    text.includes("<user_request_abc123>\nFix the bug\n</user_request_abc123>")
  );
  assert.ok(text.indexOf("LOWER PRIORITY") < text.indexOf("<user_request_abc123>"));
  assert.ok(!text.includes("TOOL PROTOCOL"));
});

test("buildUserPrompt omits the context block when there is no client context", () => {
  const text = buildUserPrompt({ prompt: "hello", nonce: "n1" });

  assert.equal(text, "<user_request_n1>\nhello\n</user_request_n1>");
});

test("buildUserPrompt appends the tool protocol only when requested", () => {
  const tools = [{ name: "read_file", parameters: { type: "object" } }];
  const text = buildUserPrompt({
    prompt: "hello",
    tools,
    toolProtocol: TOOL_PROTOCOL,
    nonce: "n2"
  });

  assert.match(text, /TOOL PROTOCOL: assistant-json-v1/);
  assert.match(text, /read_file/);
  assert.match(text, /protocol marker for this turn is n2/);

  const instructions = toolProtocolInstructions([], "n3");
  assert.match(instructions, /no client tools were provided/);
  assert.match(instructions, /n3/);
});

test("parseAssistantPayload is a pass-through when the protocol is disabled", () => {
  const parsed = parseAssistantPayload("plain text", { toolProtocol: "none" });

  assert.deepEqual(parsed, {
    type: "text",
    text: "plain text",
    toolCalls: null,
    protocolError: null
  });
});

test("parseAssistantPayload parses final messages and tolerates fences", () => {
  const plain = parseAssistantPayload(
    JSON.stringify({ type: "message", content: "final answer" }),
    { toolProtocol: TOOL_PROTOCOL }
  );
  assert.deepEqual(plain, {
    type: "message",
    text: "final answer",
    toolCalls: null,
    protocolError: null
  });

  const fenced = parseAssistantPayload(
    '```json\n{"type":"message","content":"fenced"}\n```',
    { toolProtocol: TOOL_PROTOCOL }
  );
  assert.equal(fenced.type, "message");
  assert.equal(fenced.text, "fenced");

  const surrounded = parseAssistantPayload(
    'Here you go: {"type":"message","content":"wrapped"} done',
    { toolProtocol: TOOL_PROTOCOL }
  );
  assert.equal(surrounded.type, "message");
  assert.equal(surrounded.text, "wrapped");
});

test("parseAssistantPayload parses tool calls without executing them", () => {
  const tools = [{ name: "read_file" }, { name: "run_test" }];
  const parsed = parseAssistantPayload(
    JSON.stringify({
      type: "tool_call",
      tool_calls: [
        { name: "read_file", arguments: { path: "a.js" } },
        { id: "call_given", name: "run_test", arguments: '{"suite":"unit"}' },
        { name: "read_file" }
      ]
    }),
    { tools, toolProtocol: TOOL_PROTOCOL }
  );

  assert.equal(parsed.type, "tool_call");
  assert.equal(parsed.text, "");
  assert.equal(parsed.protocolError, null);
  assert.equal(parsed.toolCalls.length, 3);
  assert.equal(parsed.toolCalls[0].name, "read_file");
  assert.deepEqual(parsed.toolCalls[0].arguments, { path: "a.js" });
  assert.equal(parsed.toolCalls[0].executed, false);
  assert.match(parsed.toolCalls[0].id, /^call_/);
  assert.equal(parsed.toolCalls[1].id, "call_given");
  assert.deepEqual(parsed.toolCalls[1].arguments, { suite: "unit" });
  assert.deepEqual(parsed.toolCalls[2].arguments, {});
});

test("parseAssistantPayload reports protocol errors without throwing", () => {
  const tools = [{ name: "read_file" }];
  const parse = text =>
    parseAssistantPayload(text, { tools, toolProtocol: TOOL_PROTOCOL });

  assert.equal(parse("").protocolError.code, "empty_response");
  assert.equal(parse("not json").protocolError.code, "invalid_json");
  assert.equal(
    parse(JSON.stringify({ type: "message", content: 1 })).protocolError.code,
    "invalid_message"
  );
  assert.equal(
    parse(JSON.stringify({ type: "hello" })).protocolError.code,
    "unrecognized_payload"
  );
  assert.equal(
    parse(JSON.stringify({ type: "tool_call", tool_calls: [] })).protocolError
      .code,
    "empty_tool_calls"
  );
  assert.equal(
    parse(
      JSON.stringify({
        type: "tool_call",
        tool_calls: [{ name: "missing", arguments: {} }]
      })
    ).protocolError.code,
    "unknown_tool"
  );
  assert.equal(
    parse(
      JSON.stringify({
        type: "tool_call",
        tool_calls: [{ name: "read_file", arguments: "[1,2]" }]
      })
    ).protocolError.code,
    "invalid_tool_arguments"
  );
  assert.equal(
    parse(
      JSON.stringify({
        type: "tool_call",
        tool_calls: [{ name: "read_file", arguments: "not-json" }]
      })
    ).protocolError.code,
    "invalid_tool_arguments"
  );
  assert.equal(
    parse(
      JSON.stringify({ type: "tool_call", tool_calls: [{ arguments: {} }] })
    ).protocolError.code,
    "invalid_tool_call"
  );

  const noTools = parseAssistantPayload(
    JSON.stringify({
      type: "tool_call",
      tool_calls: [{ name: "read_file", arguments: {} }]
    }),
    { tools: [], toolProtocol: TOOL_PROTOCOL }
  );
  assert.equal(noTools.protocolError.code, "no_tools_available");
});

test("extractTurnFromNewest identifies the completed turn", () => {
  const newestFirst = [
    idleMessage(),
    assistantMessage({ id: "msg_answer" }),
    assistantMessage({ id: "msg_tool_only", content: [{ type: "tool" }] }),
    userMessage("msg_user")
  ];

  const turn = extractTurnFromNewest(newestFirst, 3);

  assert.equal(turn.userMessage.id, "msg_user");
  assert.equal(turn.idle.outcome, "succeeded");
  assert.deepEqual(
    turn.assistantMessages.map(message => message.id),
    ["msg_tool_only", "msg_answer"]
  );
  assert.equal(turn.assistant.id, "msg_answer");
  assert.deepEqual(
    turn.turn.map(message => message.id),
    ["msg_tool_only", "msg_answer", "msg_idle"]
  );

  assert.equal(extractTurnFromNewest(newestFirst, -1), null);
});

test("readTurn pages backwards until it finds the user message", async () => {
  const pages = new Map([
    [
      undefined,
      {
        data: [idleMessage(), assistantMessage()],
        cursor: { previous: null, next: "cursor-2" }
      }
    ],
    [
      "cursor-2",
      {
        data: [userMessage("msg_user")],
        cursor: { previous: null, next: null }
      }
    ]
  ]);

  const fake = fakeOpenCode({
    listMessagesImpl(sessionID, query) {
      assert.equal(sessionID, "ses_1");
      const page = pages.get(query.cursor);
      assert.ok(page, `unexpected cursor ${query.cursor}`);
      return page;
    }
  });

  const turn = await readTurn(fake, "ses_1", "msg_user");

  assert.equal(turn.userMessage.id, "msg_user");
  assert.equal(turn.idle.outcome, "succeeded");
  assert.equal(turn.assistant.id, "msg_assistant");
  assert.equal(fake.listMessageCalls.length, 2);
  assert.equal(fake.listMessageCalls[0].query.order, "desc");
  assert.equal(fake.listMessageCalls[1].query.cursor, "cursor-2");
});

test("readTurn returns null when the turn cannot be found", async () => {
  const fake = fakeOpenCode({
    listMessagesImpl: async () => ({
      data: [idleMessage()],
      cursor: { previous: null, next: null }
    })
  });

  assert.equal(await readTurn(fake, "ses_1", "msg_missing"), null);
});

test("readTurnWithRetry retries while a successful turn has no assistant response", async () => {
  let calls = 0;
  const fake = fakeOpenCode({
    listMessagesImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          data: [idleMessage(), userMessage()],
          cursor: { previous: null, next: null }
        };
      }
      return {
        data: [idleMessage(), assistantMessage(), userMessage()],
        cursor: { previous: null, next: null }
      };
    }
  });

  const turn = await readTurnWithRetry(fake, "ses_1", "msg_user", {
    attempts: 3,
    delayMs: 1
  });

  assert.equal(calls, 2);
  assert.equal(turn.assistant.id, "msg_assistant");
});

test("readTurnWithRetry stops immediately for unsuccessful outcomes", async () => {
  let calls = 0;
  const fake = fakeOpenCode({
    listMessagesImpl: async () => {
      calls += 1;
      return {
        data: [idleMessage({ outcome: "failed" }), userMessage()],
        cursor: { previous: null, next: null }
      };
    }
  });

  const turn = await readTurnWithRetry(fake, "ses_1", "msg_user", {
    attempts: 3,
    delayMs: 1
  });

  assert.equal(calls, 1);
  assert.equal(turn.idle.outcome, "failed");
});

test("readTurnWithRetry refuses to continue when aborted", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    readTurnWithRetry(fakeOpenCode(), "ses_1", "msg_user", {
      signal: controller.signal
    }),
    error => error.code === "request_aborted"
  );
});

test("runPrompt returns the completed assistant turn and switches the model", async () => {
  const fake = fakeOpenCode({
    messages: [idleMessage(), assistantMessage(), userMessage("msg_user")]
  });

  const result = await runPrompt({
    opencode: fake,
    config: makeConfig(),
    sessionID: "ses_1",
    input: {
      prompt: "please answer",
      system: "client system",
      context: [{ role: "user", content: "older context" }],
      tools: [],
      toolProtocol: "none",
      model: "mock/mock-model#high"
    },
    logger: silentLogger
  });

  assert.deepEqual(fake.switched, [
    {
      sessionID: "ses_1",
      model: { providerID: "mock", id: "mock-model", variant: "high" }
    }
  ]);
  assert.match(fake.promptText, /<client_system_[0-9a-f]+>/);
  assert.match(fake.promptText, /client system/);
  assert.match(fake.promptText, /older context/);
  assert.match(fake.promptText, /please answer/);
  assert.doesNotMatch(fake.promptText, /TOOL PROTOCOL/);

  assert.equal(result.protocol, "worker.v1");
  assert.equal(result.sessionId, "ses_1");
  assert.equal(result.userMessageId, "msg_user");
  assert.equal(result.messageId, "msg_assistant");
  assert.equal(result.outcome, "succeeded");
  assert.equal(result.type, "text");
  assert.equal(result.text, "answer");
  assert.equal(result.toolCalls, null);
  assert.equal(result.toolProtocol, null);
  assert.equal(result.finish, "stop");
  assert.deepEqual(result.usage, { input: 1, output: 2 });
  assert.equal(result.cost, 0.01);
  assert.deepEqual(result.parts, [{ type: "text", text: "answer" }]);
  assert.deepEqual(result.nativeToolEvents, []);
  assert.equal(typeof result.durationMs, "number");
});

test("runPrompt parses assistant-json-v1 tool requests", async () => {
  const fake = fakeOpenCode({
    messages: [
      idleMessage(),
      assistantMessage({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              type: "tool_call",
              tool_calls: [
                { name: "read_file", arguments: { path: "src/index.js" } }
              ]
            })
          }
        ]
      }),
      userMessage("msg_user")
    ]
  });

  const result = await runPrompt({
    opencode: fake,
    config: makeConfig(),
    sessionID: "ses_1",
    input: {
      prompt: "read it",
      context: [],
      tools: [{ name: "read_file" }],
      toolProtocol: TOOL_PROTOCOL
    },
    logger: silentLogger
  });

  assert.equal(result.type, "tool_call");
  assert.equal(result.toolProtocol, TOOL_PROTOCOL);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "read_file");
  assert.deepEqual(result.toolCalls[0].arguments, { path: "src/index.js" });
  assert.equal(result.toolCalls[0].executed, false);
});

test("runPrompt reports native tool activity without exposing it as client tool calls", async () => {
  const fake = fakeOpenCode({
    messages: [
      idleMessage(),
      assistantMessage({
        content: [
          {
            type: "tool",
            id: "call_native",
            name: "write",
            executed: false,
            state: {
              status: "error",
              error: {
                type: "tool.execution",
                message: 'No tool named "write" is currently available.'
              }
            }
          }
        ]
      }),
      assistantMessage({
        id: "msg_text",
        content: [{ type: "text", text: "I could not write the file." }]
      }),
      userMessage("msg_user")
    ]
  });

  const result = await runPrompt({
    opencode: fake,
    config: makeConfig(),
    sessionID: "ses_1",
    input: {
      prompt: "write a file",
      context: [],
      tools: [],
      toolProtocol: "none"
    },
    logger: silentLogger
  });

  assert.equal(result.messageId, "msg_text");
  assert.equal(result.text, "I could not write the file.");
  assert.equal(result.toolCalls, null);
  assert.equal(result.nativeToolEvents.length, 1);
  assert.equal(result.nativeToolEvents[0].name, "write");
  assert.equal(result.nativeToolEvents[0].executed, false);
  assert.equal(result.nativeToolEvents[0].status, "error");
});

test("runPrompt fails clearly when OpenCode does not acknowledge the prompt", async () => {
  const fake = fakeOpenCode({
    promptImpl: async () => ({ data: { id: null } })
  });

  await assert.rejects(
    runPrompt({
      opencode: fake,
      config: makeConfig(),
      sessionID: "ses_1",
      input: { prompt: "hello", context: [], tools: [], toolProtocol: "none" },
      logger: silentLogger
    }),
    error => error.code === "prompt_not_acknowledged"
  );
});

test("runPrompt interrupts on timeout", async () => {
  const fake = fakeOpenCode({
    waitImpl: async () => {
      throw new OpenCodeError("timed out", {
        status: 504,
        code: "upstream_timeout"
      });
    }
  });

  await assert.rejects(
    runPrompt({
      opencode: fake,
      config: makeConfig(),
      sessionID: "ses_1",
      input: {
        prompt: "hello",
        context: [],
        tools: [],
        toolProtocol: "none",
        timeoutMs: 1234
      },
      logger: silentLogger
    }),
    error =>
      error.code === "prompt_timeout" &&
      error.status === 504 &&
      /1234ms/.test(error.message)
  );

  assert.equal(fake.interruptCalls, 1);
});

test("runPrompt interrupts and reports an aborted client request", async () => {
  const controller = new AbortController();
  const fake = fakeOpenCode({
    waitImpl: async () => {
      controller.abort();
      throw new OpenCodeError("aborted", {
        status: 499,
        code: "request_aborted"
      });
    }
  });

  await assert.rejects(
    runPrompt({
      opencode: fake,
      config: makeConfig(),
      sessionID: "ses_1",
      input: { prompt: "hello", context: [], tools: [], toolProtocol: "none" },
      signal: controller.signal,
      logger: silentLogger
    }),
    error => error.code === "request_aborted" && error.status === 499
  );

  assert.equal(fake.interruptCalls, 1);
});

test("runPrompt maps failed, interrupted, and missing turns to worker errors", async t => {
  const scenarios = [
    {
      name: "failed outcome",
      messages: [
        idleMessage({
          outcome: "failed",
          error: {
            type: "provider.free-limit",
            message: "Free usage limit reached"
          }
        }),
        userMessage()
      ],
      code: "prompt_failed",
      status: 502,
      detail: error =>
        assert.equal(error.details.error.type, "provider.free-limit")
    },
    {
      name: "interrupted outcome",
      messages: [idleMessage({ outcome: "interrupted" }), userMessage()],
      code: "prompt_interrupted",
      status: 409
    },
    {
      name: "successful outcome without assistant",
      messages: [idleMessage(), userMessage()],
      code: "no_assistant_response",
      status: 502
    },
    {
      name: "assistant error",
      messages: [
        idleMessage(),
        assistantMessage({
          error: { type: "provider.transport", message: "transport failed" }
        }),
        userMessage()
      ],
      code: "prompt_failed",
      status: 502
    },
    {
      name: "assistant finish=error",
      messages: [
        idleMessage(),
        assistantMessage({ finish: "error", content: [] }),
        userMessage()
      ],
      code: "prompt_failed",
      status: 502
    },
    {
      name: "turn not found",
      messages: [],
      code: "turn_not_found",
      status: 502
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const fake = fakeOpenCode({ messages: scenario.messages });
      await assert.rejects(
        runPrompt({
          opencode: fake,
          config: makeConfig(),
          sessionID: "ses_1",
          input: {
            prompt: "hello",
            context: [],
            tools: [],
            toolProtocol: "none"
          },
          logger: silentLogger
        }),
        error => {
          assert.equal(error.code, scenario.code);
          assert.equal(error.status, scenario.status);
          scenario.detail?.(error);
          return true;
        }
      );
    });
  }
});

test("runPrompt rejects before prompting when already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const fake = fakeOpenCode();

  await assert.rejects(
    runPrompt({
      opencode: fake,
      config: makeConfig(),
      sessionID: "ses_1",
      input: { prompt: "hello", context: [], tools: [], toolProtocol: "none" },
      signal: controller.signal,
      logger: silentLogger
    }),
    error => error.code === "request_aborted"
  );

  assert.equal(fake.promptText, undefined);
});

test("protocol constants are stable", () => {
  assert.equal(TOOL_PROTOCOL, "assistant-json-v1");
  assert.deepEqual([...ALLOWED_PROTOCOLS], ["assistant-json-v1", "none"]);
});
