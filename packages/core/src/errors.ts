/** Base class for AIRoute errors that carry an HTTP status. */
export class AirouteError extends Error {
  override readonly name: string = "AirouteError";
}

export class ValidationError extends AirouteError {
  override readonly name = "ValidationError";
  readonly status = 400;
}

/** Thrown for unreadable/invalid configuration files. Message includes the offending JSON path. */
export class ConfigError extends AirouteError {
  override readonly name = "ConfigError";
}

/**
 * Raised by sources to surface a provider-level HTTP failure (429 passthrough,
 * 401 bad key, upstream 5xx...). The gateway maps `status` onto the response
 * and forwards `code` inside the OpenAI error envelope.
 */
export class UpstreamError extends AirouteError {
  override readonly name = "UpstreamError";
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.status = options.status ?? 502;
    if (options.code !== undefined) this.code = options.code;
  }
}

/** OpenAI-style error envelope type: `{ error: { message, type, code } }`. */
export interface ErrorBody {
  error: {
    message: string;
    type: string;
    code: string | null;
  };
}

function statusToType(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "invalid_request_error";
  if (status === 413) return "invalid_request_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
}

/** Build the OpenAI error envelope for a status + message + code. */
export function makeErrorBody(message: string, status: number, code: string | null = null): ErrorBody {
  return { error: { message, type: statusToType(status), code } };
}
