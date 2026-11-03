class WorkerError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "WorkerError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

class OpenCodeError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "OpenCodeError";
    this.status = options.status || 502;
    this.upstreamStatus = options.upstreamStatus;
    this.code = options.code || "opencode_error";
    this.body = options.body;
    this.cause = options.cause;
  }
}

function toPublicError(error) {
  if (error instanceof WorkerError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details })
        }
      }
    };
  }

  if (error instanceof OpenCodeError) {
    const upstreamStatus = error.upstreamStatus;
    let status = error.status;

    if (upstreamStatus === 400) status = 400;
    else if (upstreamStatus === 404) status = 404;
    else if (upstreamStatus === 409) status = 409;
    else if (upstreamStatus === 429) status = 503;
    else if (upstreamStatus >= 500) status = 502;

    return {
      status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(upstreamStatus === undefined
            ? {}
            : { upstreamStatus }),
          ...(error.body === undefined ? {} : { details: error.body })
        }
      }
    };
  }

  if (error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return {
      status: 504,
      body: {
        error: {
          code: "timeout",
          message: "The operation timed out"
        }
      }
    };
  }

  return {
    status: 500,
    body: {
      error: {
        code: "internal_error",
        message: "Internal worker error"
      }
    }
  };
}

module.exports = {
  WorkerError,
  OpenCodeError,
  toPublicError
};
