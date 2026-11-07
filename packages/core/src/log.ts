/**
 * Minimal structured logger: one JSON line per event.
 *
 * `debug` output is gated by the `AIRROUTE_LOG=debug` environment variable
 * (checked when the logger is created).
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  /** Returns a logger with the same settings and a sub-scope. */
  child(scope: string): Logger;
}

export interface LoggerOptions {
  /** Base scope. Defaults to `"airoute"`. */
  scope?: string;
  /** Stream for info/debug lines; default `process.stdout`. */
  out?: NodeJS.WriteStream;
  /** Stream for warn/error lines; default `process.stderr`. */
  err?: NodeJS.WriteStream;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function baseLevel(): LogLevel {
  const tag = process.env["AIRROUTE_LOG"] ?? "";
  return tag.toLowerCase() === "debug" ? "debug" : "info";
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    try {
      return JSON.stringify(String(value));
    } catch {
      return '"[unserializable]"';
    }
  }
}

class StructuredLogger implements Logger {
  readonly #scope: string;
  readonly #minLevel: LogLevel;
  readonly #out: NodeJS.WriteStream;
  readonly #err: NodeJS.WriteStream;

  constructor(options: LoggerOptions = {}) {
    this.#scope = options.scope ?? "airoute";
    this.#minLevel = baseLevel();
    this.#out = options.out ?? process.stdout;
    this.#err = options.err ?? process.stderr;
  }

  child(scope: string): Logger {
    return new StructuredLogger({
      scope: `${this.#scope}:${scope}`,
      out: this.#out,
      err: this.#err,
    });
  }

  debug(message: string, data?: unknown): void {
    this.#emit("debug", message, data);
  }

  info(message: string, data?: unknown): void {
    this.#emit("info", message, data);
  }

  warn(message: string, data?: unknown): void {
    this.#emit("warn", message, data);
  }

  error(message: string, data?: unknown): void {
    this.#emit("error", message, data);
  }

  #emit(level: LogLevel, message: string, data?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.#minLevel]) return;
    const line = {
      ts: new Date().toISOString(),
      level,
      scope: this.#scope,
      msg: message,
      ...(data !== undefined ? { data } : {}),
    };
    const stream = level === "warn" || level === "error" ? this.#err : this.#out;
    stream.write(`${safeStringify(line)}\n`);
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return new StructuredLogger(options);
}
