const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { SYSTEM_PROMPT } = require("./system-prompt");

const PACKAGE = require("../package.json");

const DENY_ALL = Object.freeze({
  action: "*",
  resource: "*",
  effect: "deny"
});

const SECURITY_POLICIES = Object.freeze([
  { action: "tool.use", resource: "*", effect: "deny" },
  { action: "skill.use", resource: "*", effect: "deny" },
  { action: "mcp.use", resource: "*", effect: "deny" },
  { action: "plugin.use", resource: "*", effect: "deny" }
]);

// These are deploy-time settings that may add providers/models, but must not
// weaken the worker's fixed identity or sandbox.
const FORBIDDEN_EXTRA_CONFIG_KEYS = Object.freeze([
  "agent",
  "agents",
  "autoshare",
  "command",
  "commands",
  "default_agent",
  "instructions",
  "mcp",
  "mode",
  "permission",
  "permissions",
  "plugins",
  "policies",
  "reference",
  "references",
  "share",
  "skills",
  "tools",
  "update"
]);

function envString(env, name, fallback) {
  const value = env[name];
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallback;
  }
  return String(value).trim();
}

function envInteger(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = envString(env, name);
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(
      `${name} must be an integer between ${min} and ${max} (received ${raw})`
    );
  }
  return value;
}

function envBoolean(env, name, fallback) {
  const raw = envString(env, name);
  if (raw === undefined) return fallback;

  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;

  throw new Error(`${name} must be a boolean (true/false)`);
}

function parseJsonEnv(env, name) {
  const raw = envString(env, name);
  if (raw === undefined) return {};

  let value;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error.message}`);
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value;
}

function buildOpenCodeConfig(config) {
  const extra = config.extraConfig || {};

  for (const key of FORBIDDEN_EXTRA_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(extra, key)) {
      throw new Error(
        `OPENCODE_EXTRA_CONFIG must not set "${key}"; the worker enforces it`
      );
    }
  }

  const generated = {
    ...extra,
    $schema: "https://opencode.ai/config.json",
    default_agent: "worker",
    update: "disable",
    share: "disabled",
    autoshare: false,
    snapshots: false,
    formatter: false,
    lsp: false,
    instructions: [],
    commands: {},
    plugins: [],
    skills: { paths: [], urls: [] },
    mcp: { servers: {} },
    compaction: { auto: false },
    experimental: {
      ...(extra.experimental && typeof extra.experimental === "object"
        ? extra.experimental
        : {}),
      schedules: false,
      artifacts: false,
      image_generate: false,
      background_compaction: false,
      todo: false
    },
    permissions: [DENY_ALL],
    policies: SECURITY_POLICIES,
    tools: { "*": false },
    agents: {
      ...(extra.agents && typeof extra.agents === "object" ? extra.agents : {}),
      worker: {
        mode: "primary",
        description:
          "Remote reasoning worker. Fixed system prompt. All local tools are denied.",
        system: SYSTEM_PROMPT,
        steps: 1,
        tools: { "*": false },
        permissions: [DENY_ALL]
      }
    }
  };

  // A deploy-time model may be supplied explicitly. Otherwise the model can be
  // chosen per session or per prompt from the configured providers.
  if (config.model) {
    generated.model = config.model;
  }

  return generated;
}

function loadConfig(env = process.env) {
  const apiKey = envString(env, "API_KEY");
  if (!apiKey) {
    throw new Error("API_KEY environment variable is required");
  }

  const workerId = envString(env, "WORKER_ID");
  if (!workerId) {
    throw new Error("WORKER_ID environment variable is required");
  }

  const port = envInteger(env, "PORT", 3000, { min: 0, max: 65535 });
  const opencodePort = envInteger(env, "OPENCODE_PORT", 4100, {
    min: 1,
    max: 65535
  });
  if (port !== 0 && port === opencodePort) {
    throw new Error("PORT and OPENCODE_PORT must be different");
  }

  const home = path.resolve(envString(env, "HOME", "/data"));
  const workspace = path.resolve(
    envString(env, "WORKSPACE", path.join(home, "workspace"))
  );

  if (workspace === path.parse(workspace).root) {
    throw new Error("WORKSPACE must not be the filesystem root");
  }

  const opencodeUsername = envString(env, "OPENCODE_USERNAME", "opencode");
  const opencodePassword =
    envString(env, "OPENCODE_PASSWORD") ||
    crypto.randomBytes(24).toString("hex");

  const extraConfig = parseJsonEnv(env, "OPENCODE_EXTRA_CONFIG");
  const model = envString(env, "OPENCODE_MODEL");

  const config = {
    apiKey,
    workerId,
    workerName: envString(env, "WORKER_NAME", "opencode-remote-reasoning-worker"),
    workerVersion: PACKAGE.version,
    port,
    opencodePort,
    host: envString(env, "HOST", "0.0.0.0"),
    home,
    workspace,
    opencode: {
      bin: envString(env, "OPENCODE_BIN", "opencode"),
      hostname: "127.0.0.1",
      username: opencodeUsername,
      password: opencodePassword,
      url: `http://127.0.0.1:${opencodePort}`,
      model: model || null,
      extraConfig
    },
    limits: {
      maxConcurrentPrompts: envInteger(env, "MAX_CONCURRENT_PROMPTS", 4, {
        min: 1,
        max: 64
      }),
      promptTimeoutMs: envInteger(env, "PROMPT_TIMEOUT_MS", 180000, {
        min: 1000,
        max: 1800000
      }),
      requestTimeoutMs: envInteger(env, "REQUEST_TIMEOUT_MS", 30000, {
        min: 1000,
        max: 600000
      }),
      startupTimeoutMs: envInteger(env, "OPENCODE_START_TIMEOUT_MS", 120000, {
        min: 1000,
        max: 600000
      }),
      shutdownTimeoutMs: envInteger(env, "SHUTDOWN_TIMEOUT_MS", 15000, {
        min: 1000,
        max: 120000
      }),
      bodyLimit: envString(env, "BODY_LIMIT", "10mb"),
      maxContextMessages: envInteger(env, "MAX_CONTEXT_MESSAGES", 100, {
        min: 1,
        max: 1000
      }),
      maxTools: envInteger(env, "MAX_TOOLS", 64, {
        min: 1,
        max: 256
      })
    },
    enableEventProxy: envBoolean(env, "ENABLE_EVENT_PROXY", false),
    corsOrigins: envString(env, "CORS_ORIGIN")
      ? envString(env, "CORS_ORIGIN")
          .split(",")
          .map(value => value.trim())
          .filter(Boolean)
      : [],
    logLevel: envString(env, "LOG_LEVEL", "info")
  };

  config.opencode.config = buildOpenCodeConfig({
    extraConfig,
    model: config.opencode.model
  });
  config.opencode.configContent = JSON.stringify(config.opencode.config);

  return config;
}

function ensureRuntimeDirectories(config) {
  fs.mkdirSync(config.home, { recursive: true });
  fs.mkdirSync(config.workspace, { recursive: true });

  const stat = fs.statSync(config.workspace);
  if (!stat.isDirectory()) {
    throw new Error(`WORKSPACE is not a directory: ${config.workspace}`);
  }

  fs.accessSync(config.workspace, fs.constants.R_OK | fs.constants.W_OK);

  for (const directory of [
    path.join(config.home, ".local", "share", "opencode"),
    path.join(config.home, ".config", "opencode")
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

module.exports = {
  DENY_ALL,
  SECURITY_POLICIES,
  FORBIDDEN_EXTRA_CONFIG_KEYS,
  buildOpenCodeConfig,
  loadConfig,
  ensureRuntimeDirectories
};
