const http = require("http");
const { loadConfig, ensureRuntimeDirectories } = require("./config");
const { createLogger } = require("./logger");
const { OpenCodeClient } = require("./opencode-client");
const { startOpenCode, stopOpenCode } = require("./opencode-process");
const { createApp } = require("./app");

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  let config;
  try {
    config = loadConfig();
    ensureRuntimeDirectories(config);
  } catch (error) {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event: "startup_failed",
        error: error.message
      })
    );
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(config.logLevel);

  logger.info("worker_configuring", {
    workerId: config.workerId,
    version: config.workerVersion,
    port: config.port,
    opencodePort: config.opencodePort,
    workspace: config.workspace,
    opencodeBin: config.opencode.bin,
    opencodeModel: config.opencode.model,
    maxConcurrentPrompts: config.limits.maxConcurrentPrompts,
    eventProxy: config.enableEventProxy
  });

  const client = new OpenCodeClient({
    baseUrl: config.opencode.url,
    username: config.opencode.username,
    password: config.opencode.password,
    timeoutMs: config.limits.requestTimeoutMs
  });

  let opencodeProcess;
  try {
    const started = await startOpenCode({ config, client, logger });
    opencodeProcess = started.process;
  } catch (error) {
    logger.error("startup_failed", { error: error.message });
    process.exitCode = 1;
    return;
  }

  const { app, state } = createApp({
    config,
    opencode: client,
    logger
  });

  const server = http.createServer(app);
  server.requestTimeout = config.limits.promptTimeoutMs + 60000;
  server.headersTimeout = 30000;
  server.keepAliveTimeout = 65000;
  server.maxRequestsPerSocket = 0;

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    logger.error("listen_failed", {
      host: config.host,
      port: config.port,
      error: error.message
    });
    await stopOpenCode(opencodeProcess, logger, config.limits.shutdownTimeoutMs);
    process.exitCode = 1;
    return;
  }

  const address = server.address();
  logger.info("worker_listening", {
    host: config.host,
    port: typeof address === "object" && address ? address.port : config.port,
    workerId: config.workerId
  });

  let shuttingDown = false;

  async function shutdown(signal, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    state.shuttingDown = true;

    logger.info("shutdown_started", {
      signal,
      activePrompts: state.activePromptCount
    });

    const closePromise = new Promise(resolve => server.close(resolve));

    for (const sessionID of state.activeSessions) {
      try {
        await client.interrupt(sessionID);
      } catch (error) {
        logger.warn("shutdown_interrupt_failed", {
          sessionId: sessionID,
          error: error.message
        });
      }
    }

    const deadline = Date.now() + config.limits.shutdownTimeoutMs;
    while (state.activePromptCount > 0 && Date.now() < deadline) {
      await sleep(100);
    }

    if (state.activePromptCount > 0) {
      logger.warn("shutdown_prompts_still_active", {
        activePrompts: state.activePromptCount
      });
    }

    server.closeAllConnections?.();
    await Promise.race([closePromise, sleep(2000)]);

    await stopOpenCode(
      opencodeProcess,
      logger,
      config.limits.shutdownTimeoutMs
    );

    logger.info("shutdown_complete", { signal, exitCode });
    process.exit(exitCode);
  }

  process.on("SIGTERM", () => {
    shutdown("SIGTERM", 0).catch(error => {
      logger.error("shutdown_failed", { error: error.message });
      process.exit(1);
    });
  });

  process.on("SIGINT", () => {
    shutdown("SIGINT", 0).catch(error => {
      logger.error("shutdown_failed", { error: error.message });
      process.exit(1);
    });
  });

  process.on("unhandledRejection", reason => {
    logger.error("unhandled_rejection", {
      error: reason?.message || String(reason)
    });
    shutdown("unhandledRejection", 1).catch(() => process.exit(1));
  });

  process.on("uncaughtException", error => {
    logger.error("uncaught_exception", {
      error: error.message,
      stack: error.stack
    });
    shutdown("uncaughtException", 1).catch(() => process.exit(1));
  });

  opencodeProcess.exitPromise.then(({ code, signal }) => {
    if (shuttingDown) return;
    logger.error("opencode_exited", { code, signal });
    shutdown("opencode_exit", 1).catch(() => process.exit(1));
  });
}

if (require.main === module) {
  main().catch(error => {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        event: "startup_failed",
        error: error.message,
        stack: error.stack
      })
    );
    process.exit(1);
  });
}

module.exports = { main };
