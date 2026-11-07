/**
 * AIRoute intermediate representation (IR) types.
 *
 * The IR is the gateway-internal, provider-agnostic request/response shape.
 * Sources implement `Source` and translate between IR and their provider's
 * wire protocol. The gateway translates between IR and the OpenAI wire
 * protocol (`openai-wire.ts`).
/** Phase 1 supports plain-text content only. */
export type Role = "system" | "user" | "assistant" | "tool";
/** JSON-encoded argument string for a tool call (`JSON.parse` → arguments object). */
export interface ToolCall {
  id: string;
  name: string;
  /** JSON-string. */
  arguments: string;
}

export interface ToolSpec {
  name: string;
  description?: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface IRMessage {
  role: Role;
  /** Phase 1: plain text only. */
  content: string;
  /** Typed now; allowed-but-not-exercised in Phase 1. */
  toolCalls?: ToolCall[];
  /** Set on `role: "tool"` messages (responds to the matching ToolCall.id). */
  toolCallId?: string;
  name?: string;
}

export interface IRRequest {
  /** Gateway-level id, e.g. "zai/glm-4.5-air" or the alias "free-best". */
  model: string;
  messages: IRMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: ToolSpec[];
  tool_choice?: "auto" | "none" | { name: string };
}

/**
 * A normalized streamed response chunk.
 *
 * Conventions:
 * - The first chunk usually carries `role`.
 * - `content` chunks carry the text delta only (not the accumulated text).
 * - The terminal chunk carries `finishReason` plus `done: true`.
 */
export interface IRChunk {
  index: number;
  /** Set on the first chunk. */
  role?: Role;
  /** Text delta. */
  content?: string;
  finishReason?: "stop" | "length" | "tool_calls" | null;
  done?: boolean;
}

export interface IRUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export interface ModelCaps {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
}

/**
 * A model exposed by exactly one source.
 *
 * `id` is the gateway-level model id (`"<sourceId>/<sourceModelId>"`). For
 * example the mock source (`"mock"`) serving provider model `"mock/basic"`
 * exposes id `"mock/mock/basic"`.
 */
export interface ModelSpec {
  id: string;
  sourceId: string;
  sourceModelId: string;
  label: string;
  /** 0 = unknown. */
  contextWindow: number;
  caps: ModelCaps;
  /**
   * Literal `true`. AIRoute routes free models only; paid models must not
   * type-check into this field. (The gateway re-checks at runtime.)
   */
  free: true;
  aliases: string[];
  meta?: Record<string, unknown>;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs?: number;
  error?: string;
  /** ISO timestamp of the probe. */
  at: string;
}

/**
 * The contract every source plugin implements.
 *
 * Source packages register a factory that receives their config entry and
 * returns a `Source`; the registry routes requests to one of the models the
 * source advertises via `listModels()`.
 *
 * `stream()` may reject with `UpstreamError` (e.g. `status: 429`) to surface a
 * provider-level HTTP failure before/while streaming; the gateway maps that
 * onto the OpenAI error envelope. Errors raised after the first chunk are
 * delivered by erroring the returned `ReadableStream`.
 */
export interface Source {
  id: string;
  listModels(): Promise<ModelSpec[]>;
  stream(req: { model: ModelSpec; request: IRRequest }): Promise<ReadableStream<IRChunk>>;
  probe(model: ModelSpec): Promise<ProbeResult>;
}
