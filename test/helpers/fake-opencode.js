const { OpenCodeError } = require("../../src/errors");
const { SYSTEM_PROMPT } = require("../../src/system-prompt");

let sequence = 0;

function nextID(prefix) {
  sequence += 1;
  return `${prefix}_${String(sequence).padStart(6, "0")}`;
}

class FakeOpenCode {
  constructor(options = {}) {
    this.workspace = options.workspace || "/tmp/worker-workspace";
    this.sessions = new Map();
    this.messages = new Map();
    this.models =
      options.models ||
      [
        {
          id: "mock-model",
          modelID: "mock-model",
          providerID: "mock",
          name: "Mock Model",
          enabled: true,
          status: "active",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: 128000, output: 4096 },
          variants: [{ id: "low" }, { id: "high" }],
          settings: { apiKey: "provider-secret", baseURL: "http://mock" }
        }
      ];
    this.defaultModelValue = options.defaultModel || this.models[0];
    this.providers =
      options.providers ||
      [
        {
          id: "mock",
          name: "Mock",
          activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { apiKey: "provider-secret", baseURL: "http://mock" }
        }
      ];
    this.agents =
      options.agents ||
      [
        {
          id: "worker",
          name: "worker",
          mode: "primary",
          system: SYSTEM_PROMPT,
          permissions: [{ action: "*", resource: "*", effect: "deny" }]
        },
        {
          id: "build",
          name: "Build",
          mode: "primary",
          system: "build prompt",
          permissions: [{ action: "*", resource: "*", effect: "allow" }]
        }
      ];
    this.promptResults = [...(options.promptResults || [])];
    this.promptDelayMs = options.promptDelayMs || 0;
    this.waitError = options.waitError || null;
    this.infoError = options.infoError || null;
    this.modelsError = options.modelsError || null;
    this.importError = options.importError || null;
    this.interruptCalls = 0;
    this.switchModelCalls = [];
    this.deletedSessions = [];
    this.createdAt = 0;
  }

  async info() {
    if (this.infoError) throw this.infoError;
    return { version: "2.2.5", pid: 1234 };
  }

  async listAgents() {
    return { data: this.agents };
  }

  async listModels() {
    if (this.modelsError) throw this.modelsError;
    return {
      location: { directory: this.workspace },
      data: this.models
    };
  }

  async defaultModel() {
    return { data: this.defaultModelValue };
  }

  async listProviders() {
    return {
      location: { directory: this.workspace },
      data: this.providers
    };
  }

  async listSessions(query = {}) {
    let list = [...this.sessions.values()].sort(
      (left, right) => right.time.created - left.time.created
    );

    if (query.order === "asc") list = list.reverse();

    const limit = Number(query.limit) || 50;
    return {
      location: { directory: this.workspace },
      data: list.slice(0, limit),
      cursor: { previous: null, next: null }
    };
  }

  async createSession(payload) {
    this.createdAt += 1;
    const session = {
      id: nextID("ses"),
      projectID: "proj_test",
      title: payload.title || "API Session",
      agent: payload.agent || "worker",
      model: payload.model || null,
      location: {
        directory: payload.location?.directory || this.workspace
      },
      time: { created: this.createdAt, updated: this.createdAt },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 }
      }
    };

    this.sessions.set(session.id, session);
    this.messages.set(session.id, []);
    return { data: session };
  }

  async getSession(sessionID) {
    const session = this.sessions.get(sessionID);
    if (!session) {
      throw new OpenCodeError("Session not found", {
        status: 404,
        upstreamStatus: 404,
        code: "SessionNotFoundError",
        body: {
          _tag: "SessionNotFoundError",
          message: "Session not found"
        }
      });
    }
    return { data: session };
  }

  async deleteSession(sessionID) {
    await this.getSession(sessionID);
    this.sessions.delete(sessionID);
    this.messages.delete(sessionID);
    this.deletedSessions.push(sessionID);
    return { data: true };
  }

  async updateSession(sessionID, payload) {
    const { data: session } = await this.getSession(sessionID);
    if (payload.title !== undefined) session.title = payload.title;
    if (payload.metadata !== undefined) session.metadata = payload.metadata;
    this.createdAt += 1;
    session.time.updated = this.createdAt;
    return { data: session };
  }

  async switchModel(sessionID, model) {
    const { data: session } = await this.getSession(sessionID);
    session.model = model;
    this.switchModelCalls.push({ sessionID, model });
    return { data: true };
  }

  async prompt(sessionID, text) {
    const { data: session } = await this.getSession(sessionID);

    if (this.promptDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.promptDelayMs));
    }

    const userMessage = {
      id: nextID("msg"),
      time: { created: ++this.createdAt },
      type: "user",
      text
    };

    const list = this.messages.get(sessionID);
    list.push(userMessage);

    const result = this.promptResults.shift() || { text: "ok" };
    const model = session.model || { providerID: "mock", id: "mock-model" };

    if (result.nativeTool) {
      list.push({
        id: nextID("msg"),
        time: { created: ++this.createdAt, completed: this.createdAt },
        type: "assistant",
        agent: "worker",
        model,
        content: [
          {
            type: "tool",
            id: "call_native_1",
            name: result.nativeTool.name || "write",
            executed: false,
            state: {
              status: "error",
              input: result.nativeTool.arguments || {},
              error: {
                type: "tool.execution",
                message: "No tool named \"write\" is currently available."
              }
            }
          }
        ],
        finish: "tool-calls",
        tokens: { input: 0, output: 0 }
      });

      if (result.text) {
        list.push({
          id: nextID("msg"),
          time: { created: ++this.createdAt, completed: this.createdAt },
          type: "assistant",
          agent: "worker",
          model,
          content: [{ type: "text", text: result.text }],
          finish: "stop",
          tokens: { input: 0, output: 0 }
        });
      }
    } else {
      list.push({
        id: nextID("msg"),
        time: { created: ++this.createdAt, completed: this.createdAt },
        type: "assistant",
        agent: "worker",
        model,
        content: [{ type: "text", text: result.text || "ok" }],
        finish: result.finish || "stop",
        tokens: { input: 0, output: 0 },
        ...(result.error ? { error: result.error } : {})
      });
    }

    const idle = {
      id: nextID("msg"),
      time: { created: ++this.createdAt },
      type: "idle",
      outcome: result.outcome || "succeeded",
      ...(result.idleError ? { error: result.idleError } : {})
    };
    list.push(idle);
    session.time.updated = idle.time.created;

    return { data: userMessage };
  }

  async wait(sessionID, { signal } = {}) {
    await this.getSession(sessionID);
    if (signal?.aborted) {
      throw new OpenCodeError("aborted", {
        status: 499,
        code: "request_aborted"
      });
    }
    if (this.waitError) throw this.waitError;
    return null;
  }

  async listMessages(sessionID, query = {}) {
    await this.getSession(sessionID);
    let list = [...this.messages.get(sessionID)];
    if (query.order === "desc") list = list.reverse();
    const limit = Number(query.limit) || 100;
    return {
      data: list.slice(0, limit),
      cursor: { previous: null, next: null }
    };
  }

  async interrupt(sessionID) {
    await this.getSession(sessionID);
    this.interruptCalls += 1;
    return { interrupted: true };
  }

  async exportSession(sessionID) {
    const { data: session } = await this.getSession(sessionID);
    return {
      data: {
        info: session,
        messages: [...this.messages.get(sessionID)]
      }
    };
  }

  async importSession(payload) {
    if (this.importError) throw this.importError;
    const info = {
      ...payload.info,
      id: payload.info.id || nextID("ses"),
      location: payload.location || payload.info.location
    };
    this.sessions.set(info.id, info);
    this.messages.set(info.id, payload.messages || []);
    return { data: info };
  }

  async openEventStream() {
    return {
      body: {
        getReader() {
          return {
            read: async () => ({ done: true, value: undefined }),
            cancel: async () => {}
          };
        }
      }
    };
  }
}

module.exports = { FakeOpenCode, nextID };
