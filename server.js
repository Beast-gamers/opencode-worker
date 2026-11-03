#!/usr/bin/env node
require("./src/server")
  .main()
  .catch(error => {
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
