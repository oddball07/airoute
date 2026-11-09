/**
 * Coarse token estimation for context-window routing (Phase 4.5).
 *
 * AIRoute has no tokenizer dependency. A characters/4 ratio is the usual
 * approximation for mixed English + JSON and is deliberately conservative
 * enough to be useful: it only *skips* a candidate when the prompt clearly
 * cannot fit. An underestimate just reproduces the old behaviour (the upstream
 * rejects the request and the error is passed through).
 */
import type { IRRequest } from "./types.js";

/** Approximate characters per token used by {@link estimateRequestTokens}. */
export const CHARS_PER_TOKEN = 4;

/** Rough token count for a plain string (`0` for empty). */
export function estimateTextTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Rough prompt-token estimate for an IR request: message text, tool-call
 * arguments and the tool schema JSON. Adds a small per-message overhead for
 * role/format tokens.
 */
export function estimateRequestTokens(
  request: Pick<IRRequest, "messages"> & Partial<Pick<IRRequest, "tools">>,
): number {
  let chars = 0;
  for (const message of request.messages) {
    // ~4 tokens of role/separator overhead per message.
    chars += message.content.length + message.role.length + 16;
    if (message.name !== undefined) chars += message.name.length;
    if (message.toolCallId !== undefined) chars += message.toolCallId.length;
    if (message.toolCalls !== undefined) {
      for (const call of message.toolCalls) {
        chars += call.name.length + call.arguments.length + 16;
      }
    }
  }
  if (request.tools !== undefined && request.tools.length > 0) {
    chars += JSON.stringify(request.tools).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
