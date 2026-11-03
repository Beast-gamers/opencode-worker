const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DENY_ALL,
  SECURITY_POLICIES,
  FORBIDDEN_EXTRA_CONFIG_KEYS,
  buildOpenCodeConfig,
  loadConfig,
  ensureRuntimeDirectories
} = require("../src/config");
const {
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_SHA256,
  SYSTEM_PROMPT_VERSION
} = require("../src/system-prompt");

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "worker-config-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function baseEnv(overrides = {}) {
  return {
    API_KEY: "secret-key",
    WORKER_ID: "worker-1",
    ...overrides
  };
}

test("the fixed system prompt is stable and hashed", () => {
  assert.equal(SYSTEM_PROMPT_VERSION, "remote-reasoning-v1");
  assert.match(SYSTEM_PROMPT, /^You are a remote LLM reasoning worker/);
  assert.match(SYSTEM_PROMPT, /Never execute project operations yourself/);
  assert.equal(SYSTEM_PROMPT_SHA256.length, 64);
  assert.match(SYSTEM_PROMPT_SHA256, /^[0-9a-f]{64}$/);
});

test("loadConfig requires API_KEY and WORKER_ID", () => {
  assert.throws(() => loadConfig({}), /API_KEY/);
  assert.throws(() => loadConfig({ API_KEY: "k" }), /WORKER_ID/);
  assert.throws(() => loadConfig({ WORKER_ID: "w" }), /API_KEY/);
});

test("loadConfig applies stable defaults", t => {
  const home = temporaryDirectory(t);
  const config = loadConfig(
    baseEnv({
      HOME: home
    })
  );

  assert.equal(config.apiKey, "secret-key");
  assert.equal(config.workerId, "worker-1");
  assert.equal(config.workerName, "opencode-remote-reasoning-worker");
  assert.equal(config.port, 3000);
  assert.equal(config.opencodePort, 4100);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.opencode.hostname, "127.0.0.1");
  assert.equal(config.opencode.url, "http://127.0.0.1:4100");
  assert.equal(config.opencode.username, "opencode");
  assert.match(config.opencode.password, /^[0-9a-f]{48}$/);
  assert.equal(config.workspace, path.join(home, "workspace"));
  assert.equal(config.limits.maxConcurrentPrompts, 4);
  assert.equal(config.limits.promptTimeoutMs, 180000);
  assert.equal(config.enableEventProxy, false);
  assert.deepEqual(config.corsOrigins, []);
});

test("loadConfig validates ports, timeouts, and booleans", () => {
  assert.throws(
    () => loadConfig(baseEnv({ PORT: "abc" })),
    /PORT must be an integer/
  );
  assert.throws(
    () => loadConfig(baseEnv({ PORT: "70000" })),
    /PORT must be an integer/
  );
  assert.throws(
    () => loadConfig(baseEnv({ PORT: "4100" })),
    /PORT and OPENCODE_PORT must be different/
  );
  assert.throws(
    () => loadConfig(baseEnv({ MAX_CONCURRENT_PROMPTS: "0" })),
    /MAX_CONCURRENT_PROMPTS/
  );
  assert.throws(
    () => loadConfig(baseEnv({ OPENCODE_START_TIMEOUT_MS: "10" })),
    /OPENCODE_START_TIMEOUT_MS/
  );
  assert.throws(
    () => loadConfig(baseEnv({ ENABLE_EVENT_PROXY: "maybe" })),
    /ENABLE_EVENT_PROXY/
  );
  assert.equal(
    loadConfig(baseEnv({ ENABLE_EVENT_PROXY: "yes" })).enableEventProxy,
    true
  );
  assert.equal(
    loadConfig(baseEnv({ ENABLE_EVENT_PROXY: "off" })).enableEventProxy,
    false
  );
});

test("loadConfig parses CORS origins and rejects the filesystem root workspace", () => {
  const config = loadConfig(
    baseEnv({ CORS_ORIGIN: "https://a.example, https://b.example ," })
  );
  assert.deepEqual(config.corsOrigins, [
    "https://a.example",
    "https://b.example"
  ]);

  assert.throws(
    () => loadConfig(baseEnv({ WORKSPACE: "/" })),
    /WORKSPACE must not be the filesystem root/
  );
});

test("generated OpenCode config enforces the fixed worker identity", () => {
  const config = loadConfig(baseEnv());
  const generated = config.opencode.config;

  assert.equal(generated.default_agent, "worker");
  assert.equal(generated.update, "disable");
  assert.equal(generated.share, "disabled");
  assert.equal(generated.autoshare, false);
  assert.equal(generated.snapshots, false);
  assert.equal(generated.formatter, false);
  assert.equal(generated.lsp, false);
  assert.deepEqual(generated.instructions, []);
  assert.deepEqual(generated.commands, {});
  assert.deepEqual(generated.plugins, []);
  assert.deepEqual(generated.skills, { paths: [], urls: [] });
  assert.deepEqual(generated.mcp, { servers: {} });
  assert.deepEqual(generated.permissions, [DENY_ALL]);
  assert.deepEqual(generated.policies, SECURITY_POLICIES);
  assert.deepEqual(generated.tools, { "*": false });
  assert.equal(generated.experimental.schedules, false);
  assert.equal(generated.experimental.artifacts, false);
  assert.equal(generated.experimental.image_generate, false);
  assert.equal(generated.experimental.background_compaction, false);
  assert.equal(generated.experimental.todo, false);

  const worker = generated.agents.worker;
  assert.equal(worker.mode, "primary");
  assert.equal(worker.system, SYSTEM_PROMPT);
  assert.equal(worker.steps, 1);
  assert.deepEqual(worker.tools, { "*": false });
  assert.deepEqual(worker.permissions, [DENY_ALL]);

  assert.doesNotThrow(() => JSON.parse(config.opencode.configContent));
  assert.equal(
    JSON.parse(config.opencode.configContent).agents.worker.system,
    SYSTEM_PROMPT
  );
});

test("extra config can add providers and models but cannot weaken the worker", t => {
  const extra = {
    provider: { mock: { npm: "@ai-sdk/openai-compatible" } },
    model: "mock/mock-model",
    experimental: { something_else: true }
  };

  const generated = buildOpenCodeConfig({
    extraConfig: extra,
    model: "mock/mock-model"
  });

  assert.deepEqual(generated.provider, extra.provider);
  assert.equal(generated.model, "mock/mock-model");
  assert.equal(generated.experimental.something_else, true);
  assert.equal(generated.experimental.artifacts, false);
  assert.equal(generated.default_agent, "worker");
  assert.equal(generated.agents.worker.system, SYSTEM_PROMPT);
  assert.deepEqual(generated.agents.worker.permissions, [DENY_ALL]);
});

test("extra config keys that could weaken the worker are rejected", () => {
  for (const key of FORBIDDEN_EXTRA_CONFIG_KEYS) {
    const env = baseEnv({
      OPENCODE_EXTRA_CONFIG: JSON.stringify({ [key]: {} })
    });
    assert.throws(
      () => loadConfig(env),
      new RegExp(`OPENCODE_EXTRA_CONFIG must not set "${key}"`),
      `expected ${key} to be rejected`
    );
  }
});

test("OPENCODE_EXTRA_CONFIG must be a JSON object", () => {
  assert.throws(
    () => loadConfig(baseEnv({ OPENCODE_EXTRA_CONFIG: "{" })),
    /OPENCODE_EXTRA_CONFIG must be valid JSON/
  );
  assert.throws(
    () => loadConfig(baseEnv({ OPENCODE_EXTRA_CONFIG: "[]" })),
    /OPENCODE_EXTRA_CONFIG must be a JSON object/
  );
  assert.throws(
    () => loadConfig(baseEnv({ OPENCODE_EXTRA_CONFIG: "null" })),
    /OPENCODE_EXTRA_CONFIG must be a JSON object/
  );
});

test("ensureRuntimeDirectories creates the runtime tree", t => {
  const home = temporaryDirectory(t);
  const config = loadConfig(
    baseEnv({ HOME: home, WORKSPACE: path.join(home, "nested", "workspace") })
  );

  ensureRuntimeDirectories(config);

  assert.ok(fs.statSync(config.workspace).isDirectory());
  assert.ok(fs.statSync(path.join(home, ".local", "share", "opencode")).isDirectory());
  assert.ok(fs.statSync(path.join(home, ".config", "opencode")).isDirectory());
});

test("ensureRuntimeDirectories fails when the workspace is a file", t => {
  const home = temporaryDirectory(t);
  const workspace = path.join(home, "workspace");
  fs.writeFileSync(workspace, "not a directory");

  const config = loadConfig(baseEnv({ HOME: home, WORKSPACE: workspace }));

  assert.throws(() => ensureRuntimeDirectories(config), /EEXIST|ENOTDIR|not a directory/);
});
