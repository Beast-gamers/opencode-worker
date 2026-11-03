const LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
});

function createLogger(level = "info", sink = console) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(entryLevel, event, fields) {
    if (LEVELS[entryLevel] < threshold) return;

    const record = {
      ts: new Date().toISOString(),
      level: entryLevel,
      event,
      ...(fields && typeof fields === "object" ? fields : {})
    };

    const line = JSON.stringify(record);
    if (entryLevel === "error") sink.error(line);
    else if (entryLevel === "warn") sink.warn(line);
    else sink.log(line);
  }

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields)
  };
}

const silentLogger = createLogger("silent");

module.exports = { createLogger, silentLogger };
