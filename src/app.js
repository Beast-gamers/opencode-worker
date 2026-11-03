const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");

const { WorkerError, toPublicError } = require("./errors");
const {
  TOOL_PROTOCOL,
  ALLOWED_PROTOCOLS,
  normalizeModel,
  normalizeTools,
  normalizeContext,
  runPrompt
} = require("./prompt");
const {
  SYSTEM_PROMPT_SHA256,
  SYSTEM_PROMPT_VERSION
} = require("./system-prompt");

const MESSAGE_TYPES = new Set([
  "agent-switched",
  "model-switched",
  "location-switched",
  "user",
  "synthetic",
  "system",
  "skill",
  "shell",
  "assistant",
  "compaction",
  "idle"
]);

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left), "utf8");
  const b = Buffer.from(String(right), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function unwrap(result) {
  if (result && typeof result === "object" && "data" in result) {
    return result.data;
  }
  return result;
}

function unwrapList(result) {
  if (result && Array.isArray(result.data)) return result.data;
  if (Array.isArray(result)) return result;
  return [];
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function validateSessionID(sessionID) {
  if (
    typeof sessionID !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,256}$/.test(sessionID)
  ) {
    throw new WorkerError(400, "invalid_session_id", "Invalid session id");
  }
}

function assertSessionLocation(session, workspace) {
  const directory = session?.location?.directory;
  if (typeof directory !== "string" || !directory) return;

  if (!isInside(path.resolve(workspace), path.resolve(directory))) {
    throw new WorkerError(
      403,
      "session_location_not_allowed",
      "The session belongs to a different workspace",
      { sessionDirectory: directory, workspace }
    );
  }
}

function sanitizeModel(model) {
  if (!model || typeof model !== "object") return model;
  return {
    id: model.id ?? model.modelID ?? null,
    modelID: model.modelID ?? model.id ?? null,
    providerID: model.providerID ?? null,
    name: model.name ?? null,
    family: model.family ?? null,
    type: model.type ?? null,
    status: model.status ?? null,
    enabled: model.enabled ?? null,
    capabilities: model.capabilities ?? null,
    limit: model.limit ?? null,
    cost: model.cost ?? null,
    variants: Array.isArray(model.variants)
      ? model.variants.map(variant => ({
          id: variant.id ?? null,
          name: variant.name ?? variant.id ?? null
        }))
      : []
  };
}

function sanitizeProvider(provider) {
  if (!provider || typeof provider !== "object") return provider;
  return {
    id: provider.id ?? null,
    name: provider.name ?? null,
    activation: provider.activation ?? null,
    package: provider.package ?? null
  };
}

function sanitizeAgent(agent) {
  if (!agent || typeof agent !== "object") return agent;
  return {
    id: agent.id ?? null,
    name: agent.name ?? null,
    description: agent.description ?? null,
    mode: agent.mode ?? null,
    hidden: agent.hidden ?? null,
    model: agent.model ?? null
  };
}

function validateTitle(title) {
  if (title === undefined || title === null) return undefined;
  if (typeof title !== "string") {
    throw new WorkerError(400, "invalid_title", "title must be a string");
  }
  if (title.length > 200) {
    throw new WorkerError(
      400,
      "invalid_title",
      "title must be 200 characters or fewer"
    );
  }
  return title;
}

function validateMetadata(metadata) {
  if (metadata === undefined || metadata === null) return undefined;
  if (
    typeof metadata !== "object" ||
    Array.isArray(metadata)
  ) {
    throw new WorkerError(
      400,
      "invalid_metadata",
      "metadata must be an object"
    );
  }
  return metadata;
}

function remapImportMessages(messages) {
  return messages.map(message => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return message;
    }

    const remapped = {
      ...message,
      ...(typeof message.id === "string"
        ? { id: `msg_${crypto.randomUUID()}` }
        : {})
    };

    if (Array.isArray(message.content)) {
      remapped.content = message.content.map(part => {
        if (!part || typeof part !== "object" || Array.isArray(part)) {
          return part;
        }
        return typeof part.id === "string"
          ? { ...part, id: `part_${crypto.randomUUID()}` }
          : part;
      });
    }

    return remapped;
  });
}

function validateSessionCreateBody(body, config) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new WorkerError(
      400,
      "invalid_request",
      "A JSON request body is required"
    );
  }

  if (body.agent !== undefined && body.agent !== "worker") {
    throw new WorkerError(
      400,
      "agent_not_allowed",
      'Only the fixed "worker" agent is available'
    );
  }

  return {
    title: validateTitle(body.title) ?? "API Session",
    model: normalizeModel(body.model),
    metadata: validateMetadata(body.metadata)
  };
}

function validatePromptBody(body, config) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new WorkerError(
      400,
      "invalid_request",
      "A JSON request body is required"
    );
  }

  if (body.stream !== undefined && body.stream !== false) {
    throw new WorkerError(
      400,
      "streaming_not_supported",
      "Streaming is not supported by this worker; use the synchronous prompt response"
    );
  }

  if (body.agent !== undefined && body.agent !== "worker") {
    throw new WorkerError(
      400,
      "agent_not_allowed",
      'Only the fixed "worker" agent is available'
    );
  }

  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    throw new WorkerError(
      400,
      "invalid_prompt",
      "A non-empty prompt string is required"
    );
  }

  if (body.prompt.length > 2_000_000) {
    throw new WorkerError(413, "prompt_too_large", "prompt is too large");
  }

  if (body.system !== undefined && typeof body.system !== "string") {
    throw new WorkerError(400, "invalid_system", "system must be a string");
  }

  if (
    body.system !== undefined &&
    body.system.length > 500_000
  ) {
    throw new WorkerError(413, "system_too_large", "system is too large");
  }

  const rawContext = body.context ?? body.messages ?? [];
  const context = normalizeContext(rawContext);
  if (context.length > config.limits.maxContextMessages) {
    throw new WorkerError(
      400,
      "too_many_context_messages",
      `context may contain at most ${config.limits.maxContextMessages} messages`
    );
  }

  const tools = normalizeTools(body.tools);
  if (tools.length > config.limits.maxTools) {
    throw new WorkerError(
      400,
      "too_many_tools",
      `tools may contain at most ${config.limits.maxTools} definitions`
    );
  }

  let toolProtocol = body.toolProtocol;
  if (toolProtocol === undefined || toolProtocol === null) {
    toolProtocol = tools.length > 0 ? TOOL_PROTOCOL : "none";
  }
  if (!ALLOWED_PROTOCOLS.has(toolProtocol)) {
    throw new WorkerError(
      400,
      "invalid_tool_protocol",
      `toolProtocol must be one of ${[...ALLOWED_PROTOCOLS].join(", ")}`
    );
  }

  let timeoutMs = body.timeoutMs;
  if (timeoutMs !== undefined) {
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1000 ||
      timeoutMs > 1_800_000
    ) {
      throw new WorkerError(
        400,
        "invalid_timeout",
        "timeoutMs must be an integer between 1000 and 1800000"
      );
    }
  }

  return {
    prompt: body.prompt,
    system: body.system,
    context,
    tools,
    toolProtocol,
    model: normalizeModel(body.model),
    timeoutMs
  };
}

async function assertModelAvailable(opencode, model) {
  if (!model) return;

  const result = await opencode.listModels();
  const models = unwrapList(result);
  const found = models.find(
    candidate =>
      candidate &&
      candidate.providerID === model.providerID &&
      (candidate.modelID ?? candidate.id) === model.id &&
      candidate.enabled !== false
  );

  if (!found) {
    throw new WorkerError(
      400,
      "model_not_available",
      `Model is not available: ${model.providerID}/${model.id}`,
      { providerID: model.providerID, modelID: model.id }
    );
  }

  if (model.variant && Array.isArray(found.variants) && found.variants.length > 0) {
    const variants = found.variants.map(variant => variant.id);
    if (!variants.includes(model.variant)) {
      throw new WorkerError(
        400,
        "model_variant_not_available",
        `Model variant is not available: ${model.variant}`,
        { providerID: model.providerID, modelID: model.id, variants }
      );
    }
  }
}

function createApp({
  config,
  opencode,
  logger,
  promptRunner = runPrompt,
  state = {}
}) {
  const app = express();
  app.disable("x-powered-by");

  const runtimeState = {
    startedAt: Date.now(),
    shuttingDown: false,
    activeSessions: new Set(),
    activePromptCount: 0,
    ...state
  };

  app.use((req, res, next) => {
    req.id = req.get("x-request-id") || crypto.randomUUID();
    res.setHeader("x-request-id", req.id);
    const started = Date.now();
    res.on("finish", () => {
      logger?.debug("http_request", {
        requestId: req.id,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - started
      });
    });
    next();
  });

  if (Array.isArray(config.corsOrigins) && config.corsOrigins.length > 0) {
    app.use(
      cors({
        origin: config.corsOrigins,
        methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["authorization", "content-type", "x-request-id"],
        exposedHeaders: ["x-request-id"],
        maxAge: 600
      })
    );
  }

  app.use(
    express.json({
      limit: config.limits.bodyLimit,
      strict: true
    })
  );

  function authenticate(req, res, next) {
    const header = req.get("authorization") || "";
    const match = /^Bearer\s+(.+)$/i.exec(header);

    if (!match || !safeEqual(match[1], config.apiKey)) {
      res.setHeader("www-authenticate", 'Bearer realm="opencode-worker"');
      return res.status(401).json({
        error: {
          code: "unauthorized",
          message: "A valid Bearer API key is required"
        }
      });
    }

    next();
  }

  // Every worker route requires the Bearer API key.
  app.use(authenticate);

  app.get(
    "/health",
    (req, res) => {
      const status = runtimeState.shuttingDown ? "shutting_down" : "ok";
      res.status(runtimeState.shuttingDown ? 503 : 200).json({
        status,
        workerId: config.workerId,
        uptimeMs: Date.now() - runtimeState.startedAt
      });
    }
  );

  app.get(
    "/api/health",
    asyncHandler(async (req, res) => {
      if (runtimeState.shuttingDown) {
        return res.status(503).json({
          status: "shutting_down",
          workerId: config.workerId,
          uptimeMs: Date.now() - runtimeState.startedAt
        });
      }

      try {
        const info = await opencode.info();
        return res.json({
          status: "ready",
          workerId: config.workerId,
          uptimeMs: Date.now() - runtimeState.startedAt,
          opencode: {
            ready: true,
            version: info?.version ?? null
          }
        });
      } catch (error) {
        return res.status(503).json({
          status: "not_ready",
          workerId: config.workerId,
          uptimeMs: Date.now() - runtimeState.startedAt,
          opencode: {
            ready: false,
            error: {
              code: error.code || "opencode_unavailable",
              message: error.message
            }
          }
        });
      }
    })
  );

  const identityHandler = asyncHandler(async (req, res) => {
    res.json({
      worker: {
        id: config.workerId,
        name: config.workerName,
        version: config.workerVersion
      },
      protocol: {
        name: "worker.v1",
        prompt: "synchronous",
        streaming: false
      },
      systemPrompt: {
        version: SYSTEM_PROMPT_VERSION,
        sha256: SYSTEM_PROMPT_SHA256,
        enforced: true,
        clientSystemInstructions: "lower-priority-context-only"
      },
      capabilities: {
        sessions: true,
        messages: true,
        synchronousPrompt: true,
        interrupt: true,
        export: true,
        import: true,
        modelSelection: true,
        clientContext: true,
        clientSystemContext: "lower-priority-only",
        clientToolDefinitions: true,
        structuredToolCalls: TOOL_PROTOCOL,
        nativeClientToolExecution: false,
        streaming: false,
        rawEventProxy: config.enableEventProxy,
        automaticSessionDeletion: false,
        filesystemAccess: false,
        shellExecution: false,
        projectFileDiscovery: false
      },
      limits: {
        maxConcurrentPrompts: config.limits.maxConcurrentPrompts,
        defaultPromptTimeoutMs: config.limits.promptTimeoutMs,
        maxPromptTimeoutMs: 1_800_000,
        maxContextMessages: config.limits.maxContextMessages,
        maxTools: config.limits.maxTools,
        bodyLimit: config.limits.bodyLimit
      }
    });
  });

  app.get("/api/identity", identityHandler);
  app.get("/api/capabilities", identityHandler);

  app.get(
    "/api/models",
    asyncHandler(async (req, res) => {
      const result = await opencode.listModels();
      res.json({
        data: unwrapList(result).map(sanitizeModel)
      });
    })
  );

  app.get(
    "/api/models/default",
    asyncHandler(async (req, res) => {
      const result = await opencode.defaultModel();
      res.json({ data: sanitizeModel(unwrap(result)) });
    })
  );

  app.get(
    "/api/providers",
    asyncHandler(async (req, res) => {
      const result = await opencode.listProviders();
      res.json({
        data: unwrapList(result).map(sanitizeProvider)
      });
    })
  );

  app.get(
    "/api/agents",
    asyncHandler(async (req, res) => {
      const result = await opencode.listAgents();
      const worker = unwrapList(result).find(agent => agent.id === "worker");
      res.json({ data: worker ? [sanitizeAgent(worker)] : [] });
    })
  );

  app.get(
    "/api/sessions",
    asyncHandler(async (req, res) => {
      const limit = parseBoundedInteger(req.query.limit, 50, 1, 200);
      const order = req.query.order;
      if (order !== undefined && order !== "asc" && order !== "desc") {
        throw new WorkerError(
          400,
          "invalid_order",
          'order must be "asc" or "desc"'
        );
      }

      const result = await opencode.listSessions({
        limit,
        order,
        cursor: req.query.cursor,
        search: req.query.search,
        directory: config.workspace
      });

      res.json({
        data: unwrapList(result),
        cursor: result?.cursor ?? { previous: null, next: null }
      });
    })
  );

  app.post(
    "/api/sessions",
    asyncHandler(async (req, res) => {
      const input = validateSessionCreateBody(req.body, config);
      if (input.model) await assertModelAvailable(opencode, input.model);

      const payload = {
        title: input.title,
        agent: "worker",
        ...(input.model ? { model: input.model } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {})
      };

      const result = await opencode.createSession(payload);
      res.status(201).json({ data: unwrap(result) });
    })
  );

  app.post(
    "/api/sessions/import",
    asyncHandler(async (req, res) => {
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new WorkerError(
          400,
          "invalid_request",
          "A JSON request body is required"
        );
      }
      if (!body.info || typeof body.info !== "object" || Array.isArray(body.info)) {
        throw new WorkerError(400, "invalid_import", "info must be an object");
      }
      if (!Array.isArray(body.messages)) {
        throw new WorkerError(
          400,
          "invalid_import",
          "messages must be an array"
        );
      }

      const requestedLocation =
        body.location?.directory ?? body.info.location?.directory;
      if (requestedLocation !== undefined) {
        if (typeof requestedLocation !== "string") {
          throw new WorkerError(
            400,
            "invalid_import",
            "location.directory must be a string"
          );
        }
        if (!isInside(path.resolve(config.workspace), path.resolve(requestedLocation))) {
          throw new WorkerError(
            403,
            "session_location_not_allowed",
            "Imported sessions must belong to the worker workspace",
            { requestedLocation, workspace: config.workspace }
          );
        }
      }

      const payload = {
        info: body.info,
        messages: remapImportMessages(body.messages),
        location: { directory: config.workspace }
      };

      const result = await opencode.importSession(payload);
      const imported = unwrap(result);
      assertSessionLocation(imported, config.workspace);
      res.status(201).json({ data: imported });
    })
  );

  app.get(
    "/api/sessions/:id",
    asyncHandler(async (req, res) => {
      validateSessionID(req.params.id);
      const result = await opencode.getSession(req.params.id);
      const session = unwrap(result);
      assertSessionLocation(session, config.workspace);
      res.json({ data: session });
    })
  );

  app.patch(
    "/api/sessions/:id",
    asyncHandler(async (req, res) => {
      validateSessionID(req.params.id);
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new WorkerError(
          400,
          "invalid_request",
          "A JSON request body is required"
        );
      }

      const current = unwrap(await opencode.getSession(req.params.id));
      assertSessionLocation(current, config.workspace);

      const payload = {};
      const title = validateTitle(body.title);
      if (title !== undefined) payload.title = title;
      const metadata = validateMetadata(body.metadata);
      if (metadata !== undefined) payload.metadata = metadata;

      if (Object.keys(payload).length === 0) {
        throw new WorkerError(
          400,
          "invalid_request",
          "Provide title and/or metadata to update"
        );
      }

      const result = await opencode.updateSession(req.params.id, payload);
      res.json({ data: unwrap(result) });
    })
  );

  app.delete(
    "/api/sessions/:id",
    asyncHandler(async (req, res) => {
      validateSessionID(req.params.id);
      await opencode.deleteSession(req.params.id);
      res.json({ deleted: true, sessionId: req.params.id });
    })
  );

  app.get(
    "/api/sessions/:id/messages",
    asyncHandler(async (req, res) => {
      validateSessionID(req.params.id);
      const current = unwrap(await opencode.getSession(req.params.id));
      assertSessionLocation(current, config.workspace);

      const limit = parseBoundedInteger(req.query.limit, 100, 1, 1000);
      const order = req.query.order;
      if (order !== undefined && order !== "asc" && order !== "desc") {
        throw new WorkerError(
          400,
          "invalid_order",
          'order must be "asc" or "desc"'
        );
      }
      if (req.query.type !== undefined && !MESSAGE_TYPES.has(req.query.type)) {
        throw new WorkerError(
          400,
          "invalid_message_type",
          "Invalid message type"
        );
      }

      const result = await opencode.listMessages(req.params.id, {
        limit,
        order,
        cursor: req.query.cursor,
        type: req.query.type
      });

      res.json({
        data: unwrapList(result),
        cursor: result?.cursor ?? { previous: null, next: null }
      });
    })
  );

  app.post(
    "/api/sessions/:id/prompt",
    asyncHandler(async (req, res) => {
      validateSessionID(req.params.id);

      if (runtimeState.shuttingDown) {
        throw new WorkerError(
          503,
          "worker_shutting_down",
          "The worker is shutting down"
        );
      }

      const input = validatePromptBody(req.body, config);
      const session = unwrap(await opencode.getSession(req.params.id));
      assertSessionLocation(session, config.workspace);

      if (input.model) await assertModelAvailable(opencode, input.model);

      if (runtimeState.activeSessions.has(req.params.id)) {
        throw new WorkerError(
          409,
          "session_busy",
          "A prompt is already running for this session",
          { sessionId: req.params.id }
        );
      }

      if (
        runtimeState.activePromptCount >= config.limits.maxConcurrentPrompts
      ) {
        res.setHeader("retry-after", "1");
        throw new WorkerError(
          429,
          "worker_busy",
          "The worker has reached its concurrent prompt limit",
          {
            maxConcurrentPrompts: config.limits.maxConcurrentPrompts
          }
        );
      }

      runtimeState.activeSessions.add(req.params.id);
      runtimeState.activePromptCount += 1;

      const controller = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });

      try {
        const result = await promptRunner({
          opencode,
          config,
          sessionID: req.params.id,
          input,
          signal: controller.signal,
          logger
        });
        res.json(result);
      } finally {
        runtimeState.activeSessions.delete(req.params.id);
        runtimeState.activePromptCount -= 1;
      }
    })
  );

  app.post(
    "/api/sessions/:id/interrupt",
    asyncHandler(async (req, res) => {
      validateSessionID(req.params.id);
      const current = unwrap(await opencode.getSession(req.params.id));
      assertSessionLocation(current, config.workspace);

      const result = await opencode.interrupt(req.params.id);
      const interrupted = Boolean(
        result?.interrupted ?? result?.data?.interrupted ?? false
      );
      res.json({ interrupted, sessionId: req.params.id });
    })
  );

  app.get(
    "/api/sessions/:id/export",
    asyncHandler(async (req, res) => {
      validateSessionID(req.params.id);
      const current = unwrap(await opencode.getSession(req.params.id));
      assertSessionLocation(current, config.workspace);

      const result = await opencode.exportSession(req.params.id);
      res.json({ data: unwrap(result) });
    })
  );

  app.get(
    "/api/events",
    asyncHandler(async (req, res) => {
      if (!config.enableEventProxy) {
        throw new WorkerError(
          404,
          "event_proxy_disabled",
          "The raw OpenCode event proxy is disabled"
        );
      }

      const controller = new AbortController();
      req.on("close", () => controller.abort());

      const upstream = await opencode.openEventStream({
        signal: controller.signal
      });

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      });

      const reader = upstream.body.getReader();
      req.on("close", () => {
        reader.cancel().catch(() => {});
      });

      try {
        while (!res.destroyed) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      } catch (error) {
        logger?.warn("event_proxy_stream_error", {
          requestId: req.id,
          error: error.message
        });
      } finally {
        if (!res.destroyed) res.end();
      }
    })
  );

  app.use((req, res, next) => {
    next(
      new WorkerError(
        404,
        "not_found",
        `No route matches ${req.method} ${req.path}`
      )
    );
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);

    if (error?.type === "entity.parse.failed") {
      return res.status(400).json({
        error: {
          code: "invalid_json",
          message: "Request body must be valid JSON"
        }
      });
    }

    if (error?.type === "entity.too.large") {
      return res.status(413).json({
        error: {
          code: "body_too_large",
          message: "Request body is too large"
        }
      });
    }

    const mapped = toPublicError(error);
    const logFields = {
      requestId: req.id,
      method: req.method,
      path: req.path,
      status: mapped.status,
      code: mapped.body.error.code,
      message: mapped.body.error.message
    };

    if (mapped.status >= 500) logger?.error("request_failed", logFields);
    else logger?.warn("request_rejected", logFields);

    if (res.destroyed) return;

    res.status(mapped.status).json(mapped.body);
  });

  return { app, state: runtimeState };
}

function parseBoundedInteger(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new WorkerError(
      400,
      "invalid_query",
      `Expected an integer between ${min} and ${max}`
    );
  }
  return number;
}

module.exports = {
  createApp,
  sanitizeModel,
  sanitizeProvider,
  sanitizeAgent,
  assertSessionLocation,
  validatePromptBody,
  validateSessionCreateBody,
  remapImportMessages
};
