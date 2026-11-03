const { OpenCodeError } = require("./errors");

function encode(value) {
  return encodeURIComponent(String(value));
}

function queryString(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

function parseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

class OpenCodeClient {
  constructor({ baseUrl, username, password, timeoutMs = 30000, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.username = username;
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  authHeader() {
    return (
      "Basic " +
      Buffer.from(`${this.username}:${this.password}`, "utf8").toString("base64")
    );
  }

  async request(pathname, options = {}) {
    const {
      method = "GET",
      body,
      signal,
      timeoutMs = this.timeoutMs,
      headers = {}
    } = options;

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

    const requestHeaders = {
      accept: "application/json",
      authorization: this.authHeader(),
      ...headers
    };

    const init = {
      method,
      headers: requestHeaders,
      signal: combinedSignal
    };

    if (body !== undefined) {
      requestHeaders["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${pathname}`, init);
    } catch (error) {
      if (signal && signal.aborted) {
        throw new OpenCodeError("OpenCode request was aborted", {
          status: 499,
          code: "request_aborted",
          cause: error
        });
      }

      if (error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new OpenCodeError(
          `OpenCode did not respond within ${timeoutMs}ms`,
          { status: 504, code: "upstream_timeout", cause: error }
        );
      }

      throw new OpenCodeError(
        `Could not reach OpenCode at ${this.baseUrl}: ${error.message}`,
        { status: 502, code: "upstream_unavailable", cause: error }
      );
    }

    const text = await response.text();
    const data = parseBody(text);

    if (!response.ok) {
      const code = data?._tag || data?.error?.type || "opencode_error";
      const message =
        data?.message ||
        data?.error?.message ||
        (typeof data === "string" && data) ||
        `OpenCode request failed with HTTP ${response.status}`;

      throw new OpenCodeError(message, {
        status: response.status,
        upstreamStatus: response.status,
        code,
        body: data
      });
    }

    return data;
  }

  info() {
    return this.request("/api/info");
  }

  listAgents() {
    return this.request("/api/agent");
  }

  listModels() {
    return this.request("/api/model");
  }

  defaultModel() {
    return this.request("/api/model/default");
  }

  listProviders() {
    return this.request("/api/provider");
  }

  listSessions(params = {}) {
    return this.request(`/api/session${queryString(params)}`);
  }

  createSession(payload) {
    return this.request("/api/session", { method: "POST", body: payload });
  }

  getSession(sessionID) {
    return this.request(`/api/session/${encode(sessionID)}`);
  }

  deleteSession(sessionID) {
    return this.request(`/api/session/${encode(sessionID)}`, {
      method: "DELETE"
    });
  }

  updateSession(sessionID, payload) {
    return this.request(`/api/session/${encode(sessionID)}`, {
      method: "PATCH",
      body: payload
    });
  }

  switchModel(sessionID, model) {
    return this.request(`/api/session/${encode(sessionID)}/model`, {
      method: "POST",
      body: { model }
    });
  }

  prompt(sessionID, text) {
    return this.request(`/api/session/${encode(sessionID)}/prompt`, {
      method: "POST",
      body: { text }
    });
  }

  wait(sessionID, { signal, timeoutMs } = {}) {
    return this.request(
      `/api/experimental/session/${encode(sessionID)}/wait`,
      {
        method: "POST",
        signal,
        timeoutMs
      }
    );
  }

  listMessages(sessionID, params = {}) {
    return this.request(
      `/api/session/${encode(sessionID)}/message${queryString(params)}`
    );
  }

  interrupt(sessionID) {
    return this.request(`/api/session/${encode(sessionID)}/interrupt`, {
      method: "POST"
    });
  }

  exportSession(sessionID) {
    return this.request(
      `/api/experimental/session/${encode(sessionID)}/export`
    );
  }

  importSession(payload) {
    return this.request("/api/experimental/session/import", {
      method: "POST",
      body: payload
    });
  }

  async openEventStream({ signal } = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/event`, {
        headers: {
          accept: "text/event-stream",
          authorization: this.authHeader()
        },
        signal
      });
    } catch (error) {
      throw new OpenCodeError(
        `Could not connect to the OpenCode event stream: ${error.message}`,
        { status: 502, code: "upstream_unavailable", cause: error }
      );
    }

    if (!response.ok || !response.body) {
      throw new OpenCodeError(
        `OpenCode event stream failed with HTTP ${response.status}`,
        {
          status: 502,
          upstreamStatus: response.status,
          code: "upstream_event_stream_failed"
        }
      );
    }

    return response;
  }
}

module.exports = { OpenCodeClient, queryString };
