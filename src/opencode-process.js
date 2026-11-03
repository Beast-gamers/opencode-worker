const { spawn } = require("child_process");
const { SYSTEM_PROMPT } = require("./system-prompt");

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizePrompt(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function trackProcess(child) {
  const state = {
    exited: false,
    code: null,
    signal: null,
    spawnError: null
  };

  let resolveExit;
  const exitPromise = new Promise(resolve => {
    resolveExit = resolve;
  });

  child.once("error", error => {
    state.spawnError = error;
  });

  child.once("exit", (code, signal) => {
    state.exited = true;
    state.code = code;
    state.signal = signal;
    resolveExit({ code, signal });
  });

  return { state, exitPromise };
}

function spawnOpenCode(config, logger) {
  const args = [
    "serve",
    "--hostname",
    config.opencode.hostname,
    "--port",
    String(config.opencodePort)
  ];

  const logs = [];
  const child = spawn(config.opencode.bin, args, {
    cwd: config.workspace,
    env: {
      ...process.env,
      HOME: config.home,
      OPENCODE_SERVER_USERNAME: config.opencode.username,
      OPENCODE_SERVER_PASSWORD: config.opencode.password,
      OPENCODE_CONFIG_CONTENT: config.opencode.configContent
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  const { state, exitPromise } = trackProcess(child);

  function append(stream, chunk) {
    const lines = String(chunk)
      .split(/\r?\n/)
      .map(line => line.trimEnd())
      .filter(Boolean);

    for (const line of lines) {
      logs.push(line);
      if (logs.length > 200) logs.shift();
      logger?.[stream === "stderr" ? "warn" : "info"]("opencode_log", {
        stream,
        line
      });
    }
  }

  child.stdout?.on("data", chunk => append("stdout", chunk));
  child.stderr?.on("data", chunk => append("stderr", chunk));

  logger?.info("opencode_spawned", {
    pid: child.pid ?? null,
    bin: config.opencode.bin,
    hostname: config.opencode.hostname,
    port: config.opencodePort,
    workspace: config.workspace
  });

  return {
    child,
    state,
    exitPromise,
    lastLogs: (count = 20) => logs.slice(-count)
  };
}

function startupFailure(message, process) {
  const logs = process?.lastLogs ? process.lastLogs(20) : [];
  const suffix = logs.length
    ? ` Last OpenCode output:\n${logs.join("\n")}`
    : "";
  return new Error(`${message}${suffix}`);
}

async function waitForOpenCode(client, process, config, logger) {
  const deadline = Date.now() + config.limits.startupTimeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    if (process.state.spawnError) {
      throw startupFailure(
        `Failed to start OpenCode (${config.opencode.bin}): ${process.state.spawnError.message}`,
        process
      );
    }

    if (process.state.exited) {
      throw startupFailure(
        `OpenCode exited before becoming ready (code=${process.state.code}, signal=${process.state.signal})`,
        process
      );
    }

    try {
      const info = await client.info();
      if (!info || typeof info.version !== "string") {
        throw new Error("OpenCode /api/info did not include a version");
      }

      const major = Number.parseInt(info.version.split(".")[0], 10);
      if (major !== 2) {
        throw new Error(
          `OpenCode v2 is required (found ${info.version})`
        );
      }

      if (info.version !== "2.2.5") {
        logger?.warn("opencode_version_untested", {
          version: info.version,
          tested: "2.2.5"
        });
      }

      logger?.info("opencode_ready", {
        version: info.version,
        pid: info.pid ?? process.child.pid ?? null
      });

      return info;
    } catch (error) {
      lastError = error;
      await sleep(500);
    }
  }

  throw startupFailure(
    `OpenCode did not become ready within ${config.limits.startupTimeoutMs}ms` +
      (lastError ? ` (last error: ${lastError.message})` : ""),
    process
  );
}

async function validateWorkerAgent(client) {
  const result = await client.listAgents();
  const agents = Array.isArray(result?.data) ? result.data : [];
  const worker = agents.find(agent => agent.id === "worker");

  if (!worker) {
    throw new Error(
      'OpenCode did not load the fixed "worker" agent. Check OPENCODE_CONFIG_CONTENT handling.'
    );
  }

  if (normalizePrompt(worker.system) !== normalizePrompt(SYSTEM_PROMPT)) {
    throw new Error(
      "OpenCode did not expose the exact remote-reasoning system prompt for the worker agent"
    );
  }

  if (worker.mode !== "primary") {
    throw new Error(
      `The worker agent must be a primary agent (found mode=${worker.mode})`
    );
  }

  const permissions = Array.isArray(worker.permissions)
    ? worker.permissions
    : [];

  let lastDenyAll = -1;
  permissions.forEach((permission, index) => {
    if (
      permission.action === "*" &&
      permission.resource === "*" &&
      permission.effect === "deny"
    ) {
      lastDenyAll = index;
    }
  });

  if (lastDenyAll < 0) {
    throw new Error(
      "The worker agent permissions do not contain a deny-all rule"
    );
  }

  const allowAfterDenyAll = permissions
    .slice(lastDenyAll + 1)
    .some(permission => permission.effect === "allow");

  if (allowAfterDenyAll) {
    throw new Error(
      "The worker agent has an allow permission after the deny-all rule"
    );
  }

  return worker;
}

async function waitForWorkerAgent(client, config, logger) {
  const deadline = Date.now() + config.limits.startupTimeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      return await validateWorkerAgent(client);
    } catch (error) {
      lastError = error;
      const retryable =
        error?.status === 503 ||
        error?.code === "ServiceUnavailableError" ||
        /did not finish activating/i.test(error?.message || "");
      if (!retryable) throw error;
      logger?.debug("worker_agent_not_ready", { error: error.message });
      await sleep(500);
    }
  }

  throw lastError || new Error("OpenCode did not expose the worker agent");
}

async function waitForExit(process, timeoutMs) {
  if (process.state.exited) return true;
  const result = await Promise.race([
    process.exitPromise.then(() => true),
    sleep(timeoutMs).then(() => false)
  ]);
  return result;
}

async function stopOpenCode(process, logger, timeoutMs = 15000) {
  if (!process || !process.child) return;

  if (process.state.exited) return;

  logger?.info("opencode_stopping", { pid: process.child.pid ?? null });

  try {
    process.child.kill("SIGTERM");
  } catch (error) {
    logger?.warn("opencode_sigterm_failed", { error: error.message });
  }

  if (await waitForExit(process, timeoutMs)) {
    logger?.info("opencode_stopped", {
      code: process.state.code,
      signal: process.state.signal
    });
    return;
  }

  logger?.warn("opencode_sigkill", { pid: process.child.pid ?? null });

  try {
    process.child.kill("SIGKILL");
  } catch (error) {
    logger?.warn("opencode_sigkill_failed", { error: error.message });
  }

  await waitForExit(process, 5000);
}

async function startOpenCode({ config, client, logger }) {
  const process = spawnOpenCode(config, logger);

  try {
    const info = await waitForOpenCode(client, process, config, logger);
    await waitForWorkerAgent(client, config, logger);
    logger?.info("worker_agent_validated", {
      systemPromptVersion: "remote-reasoning-v1"
    });
    return { process, info };
  } catch (error) {
    await stopOpenCode(process, logger, 5000);
    throw error;
  }
}

module.exports = {
  spawnOpenCode,
  waitForOpenCode,
  waitForWorkerAgent,
  validateWorkerAgent,
  stopOpenCode,
  startOpenCode,
  normalizePrompt
};
