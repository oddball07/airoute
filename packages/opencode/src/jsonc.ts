/**
 * JSONC parsing for OpenCode config files.
 *
 * OpenCode configs may be strict JSON or JSONC (// line comments, block
 * comments, trailing commas). Node has no JSONC parser built in, so this file
 * strips those constructs — only outside of string literals — and defers to
 * `JSON.parse` for the real validation.
 */

interface ScannerState {
  inString: boolean;
  /** Inside a string, the previous char was a backslash escape. */
  escaped: boolean;
}

/**
 * Index of the next significant character at or after `start`, skipping
 * whitespace and both comment forms (outside strings), mirroring the scan
 * rules: `//` runs to end of line, a `/*...` block comment is skipped
 * wholesale (an unterminated one runs to end of input), and string contents
 * are never skipped. Returns -1 when input ends first.
 */
function nextSignificantIndex(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const ch = text[i] as string;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    return i;
  }
  return -1;
}

/** Advance one literal character, tracking string/escape state. */
function scanChar(ch: string, state: ScannerState, emit: (ch: string) => void): void {
  emit(ch);
  if (state.inString) {
    if (state.escaped) {
      state.escaped = false;
    } else if (ch === "\\") {
      state.escaped = true;
    } else if (ch === '"') {
      state.inString = false;
    }
  } else if (ch === '"') {
    state.inString = true;
  }
}

function scan(text: string, emit: (ch: string) => void): ScannerState {
  const state: ScannerState = { inString: false, escaped: false };
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (state.inString) {
      scanChar(ch, state, emit);
      i++;
      continue;
    }
    if (ch === "/") {
      const next = text[i + 1];
      if (next === "/") {
        // Line comment: drop to end of line but keep the newline itself so
        // line numbers in later error messages stay accurate.
        while (i < text.length && text[i] !== "\n") i++;
        continue;
      }
      if (next === "*") {
        const end = text.indexOf("*/", i + 2);
        const stop = end === -1 ? text.length : end + 2;
        emit(" "); // keep token boundaries (e.g. `1/*c*/2` parses as two).
        i = stop;
        continue;
      }
    }
    if (ch === "," && !state.inString) {
      const j = nextSignificantIndex(text, i + 1);
      const next = j === -1 ? undefined : text[j];
      if (next === "}" || next === "]") {
        // Trailing comma: drop it. Scanning resumes at i + 1 so skipped
        // whitespace/comments are still re-emitted (block comments as a
        // space, line comments dropped, newlines kept for later errors).
        i++;
        continue;
      }
    }
    scanChar(ch, state, emit);
    i++;
  }
  return state;
}

/**
 * Parse JSONC text (JSON with comments and trailing commas) as `unknown`.
 * Throws an `Error` naming the approximate line/offset when the underlying
 * `JSON.parse` rejects.
 */
export function parseJsonc(text: string): unknown {
  const stripped = stripCommentsAndTrailingCommas(text);
  try {
    return JSON.parse(stripped);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const position = /position\s+(\d+)/.exec(message);
    let where = "";
    if (position?.[1] !== undefined) {
      const offset = Number.parseInt(position[1], 10);
      if (Number.isInteger(offset) && offset >= 0) {
        const line = stripped.slice(0, offset).split("\n").length;
        where = ` at offset ${offset} (line ${line})`;
      }
    }
    throw new Error(`invalid JSONC${where}: ${message}`);
  }
}

function stripCommentsAndTrailingCommas(text: string): string {
  let out = "";
  scan(text, (ch) => {
    out += ch;
  });
  return out;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
