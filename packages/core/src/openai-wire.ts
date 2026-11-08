/**
 * OpenAI Chat Completions wire types + mappers to/from the AIRoute IR.
 *
 * All parsing of the outside world goes through `unknown` + narrowing; there
 * is no `any` in this module. Unexpected/invalid input raises
 * `ValidationError` (requests) or degrades to an empty chunk (response
 * chunks), never crashes the gateway.
 */
import { randomUUID } from "node:crypto";
import { ValidationError } from "./errors.js";
import type {
  IRChunk,
  IRMessage,
  IRRequest,
  Role,
  ToolCall,
  ToolCallDelta,
  ToolSpec,
} from "./types.js";

/* -------------------------------------------------------------------------- */
/* Wire types                                                                 */
/* -------------------------------------------------------------------------- */

export type OpenAIFinishReason = "stop" | "length" | "tool_calls" | null;

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * One incremental tool-call entry of a streaming `delta.tool_calls` array:
 * `{ index, id?, type?: "function", function?: { name?, arguments? } }`, where
 * later deltas for the same `index` carry only the next `arguments` fragment.
 */
export interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: { name?: string; arguments?: string };
}

export interface OpenAIMessage {
  role: string;
  /** Phase 1: plain string (or null, treated as ""). */
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAITool {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: OpenAITool[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
}

export interface OpenAIChunkChoice {
  index: number;
  delta: { role?: Role; content?: string; tool_calls?: OpenAIToolCallDelta[] };
  finish_reason: OpenAIFinishReason;
}

export interface OpenAIChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: OpenAIChunkChoice[];
}

export interface OpenAICompletionChoice {
  index: number;
  message: { role: Role; content: string };
  finish_reason: OpenAIFinishReason;
}

export interface OpenAICompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: OpenAICompletionChoice[];
}

/* -------------------------------------------------------------------------- */
/* IR → OpenAI wire                                                           */
/* -------------------------------------------------------------------------- */

/** Convert an IR request into an OpenAI Chat Completions request body. */
export function irRequestToOpenAI(req: IRRequest): OpenAIChatRequest {
  const out: OpenAIChatRequest = {
    model: req.model,
    messages: req.messages.map(irMessageToOpenAI),
  };
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.max_tokens !== undefined) out.max_tokens = req.max_tokens;
  if (req.stream !== undefined) out.stream = req.stream;
  if (req.tools !== undefined && req.tools.length > 0) {
    out.tools = req.tools.map(irToolToOpenAI);
  }
  if (req.tool_choice !== undefined) {
    out.tool_choice =
      typeof req.tool_choice === "string"
        ? req.tool_choice
        : { type: "function", function: { name: req.tool_choice.name } };
  }
  return out;
}

function irMessageToOpenAI(message: IRMessage): OpenAIMessage {
  const out: OpenAIMessage = { role: message.role, content: message.content };
  if (message.name !== undefined) out.name = message.name;
  if (message.toolCallId !== undefined) out.tool_call_id = message.toolCallId;
  if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
    out.tool_calls = message.toolCalls.map(irToolCallToOpenAI);
  }
  return out;
}

function irToolCallToOpenAI(call: ToolCall): OpenAIToolCall {
  return {
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  };
}

function irToolToOpenAI(tool: ToolSpec): OpenAITool {
  const fn: OpenAITool["function"] = { name: tool.name, parameters: tool.parameters };
  if (tool.description !== undefined) fn.description = tool.description;
  return { type: "function", function: fn };
}

/** Render an IR chunk as an OpenAI SSE chunk. `model` is echoed back to the client. */
export function irChunkToOpenAIChunk(chunk: IRChunk, model: string): OpenAIChunk {
  const delta: OpenAIChunkChoice["delta"] = {};
  if (chunk.role !== undefined) delta.role = chunk.role;
  if (chunk.content !== undefined) delta.content = chunk.content;
  const toolCalls = chunk.toolCalls?.map(irToolCallDeltaToOpenAI);
  if (toolCalls !== undefined && toolCalls.length > 0) {
    delta.tool_calls = toolCalls;
  }
  return {
    id: nextChunkId(),
    object: "chat.completion.chunk",
    created: unixNow(),
    model,
    choices: [
      {
        // `IRChunk.index` is a chunk sequence counter (used for ordering inside
        // the gateway). The OpenAI wire field is the *choice* index, which is
        // always 0 for our single-choice completions.
        index: 0,
        delta,
        finish_reason: chunk.finishReason ?? null,
      },
    ],
  };
}

/** Map one IR tool-call delta onto the OpenAI `delta.tool_calls` entry shape. */
function irToolCallDeltaToOpenAI(delta: ToolCallDelta): OpenAIToolCallDelta {
  const out: OpenAIToolCallDelta = { index: delta.index, type: "function" };
  if (delta.id !== undefined) out.id = delta.id;
  const fn: { name?: string; arguments?: string } = {};
  if (delta.name !== undefined) fn.name = delta.name;
  if (delta.arguments !== undefined) fn.arguments = delta.arguments;
  if (fn.name !== undefined || fn.arguments !== undefined) out.function = fn;
  return out;
}

/* -------------------------------------------------------------------------- */
/* OpenAI wire → IR                                                           */
/* -------------------------------------------------------------------------- */

const ROLES: readonly string[] = ["system", "user", "assistant", "tool"];

/**
 * Parse/validate an incoming Chat Completions request body into an IRRequest.
 * Throws `ValidationError` with a precise message on any malformation.
 */
export function openAIRequestToIR(body: unknown): IRRequest {
  if (!isRecord(body)) {
    throw new ValidationError("request body must be a JSON object");
  }
  const model = body["model"];
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new ValidationError('"model" must be a non-empty string');
  }
  const rawMessages = body["messages"];
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
    throw new ValidationError('"messages" must be a non-empty array');
  }
  const messages = rawMessages.map((message, index) => openAIMessageToIR(message, index));

  const out: IRRequest = { model: model as string, messages };
  const temperature = body["temperature"];
  if (temperature !== undefined) {
    if (typeof temperature !== "number" || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new ValidationError('"temperature" must be a number between 0 and 2');
    }
    out.temperature = temperature;
  }
  const topP = body["top_p"];
  if (topP !== undefined) {
    if (typeof topP !== "number" || !Number.isFinite(topP) || topP < 0 || topP > 1) {
      throw new ValidationError('"top_p" must be a number between 0 and 1');
    }
    out.top_p = topP;
  }
  const maxTokens = body["max_tokens"];
  if (maxTokens !== undefined) {
    if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens <= 0) {
      throw new ValidationError('"max_tokens" must be a positive integer');
    }
    out.max_tokens = maxTokens;
  }
  const stream = body["stream"];
  if (stream !== undefined) {
    if (typeof stream !== "boolean") throw new ValidationError('"stream" must be a boolean');
    out.stream = stream;
  }
  const tools = body["tools"];
  if (tools !== undefined) {
    if (!Array.isArray(tools)) throw new ValidationError('"tools" must be an array');
    const parsed = tools.map((tool, index) => openAIToolToIR(tool, index));
    if (parsed.length > 0) out.tools = parsed;
  }
  const toolChoice = body["tool_choice"];
  if (toolChoice !== undefined) {
    if (typeof toolChoice === "string") {
      if (toolChoice !== "auto" && toolChoice !== "none") {
        throw new ValidationError('"tool_choice" must be "auto", "none", or a function object');
      }
      out.tool_choice = toolChoice;
    } else if (isRecord(toolChoice)) {
      const fn = toolChoice["function"];
      if (!isRecord(fn) || typeof fn["name"] !== "string") {
        throw new ValidationError('"tool_choice.function.name" must be a string');
      }
      out.tool_choice = { name: fn["name"] as string };
    } else {
      throw new ValidationError('"tool_choice" must be "auto", "none", or a function object');
    }
  }
  return out;
}

function openAIMessageToIR(value: unknown, index: number): IRMessage {
  const at = `messages[${index}]`;
  if (!isRecord(value)) throw new ValidationError(`"${at}" must be an object`);
  const role = value["role"];
  if (typeof role !== "string" || !ROLES.includes(role)) {
    throw new ValidationError(
      `"${at}.role" must be one of: ${ROLES.join(", ")}`,
    );
  }
  const rawContent = value["content"];
  let content: string;
  if (rawContent === undefined || rawContent === null) {
    content = "";
  } else if (typeof rawContent === "string") {
    content = rawContent;
  } else {
    // Phase 1 carries plain text only; multimodal parts are rejected loudly.
    throw new ValidationError(
      `"${at}.content" must be a string (multimodal content parts are not supported yet)`,
    );
  }

  const message: IRMessage = { role: role as Role, content };
  const name = value["name"];
  if (name !== undefined && name !== null) {
    if (typeof name !== "string") throw new ValidationError(`"${at}.name" must be a string`);
    message.name = name;
  }
  const toolCallId = value["tool_call_id"];
  if (toolCallId !== undefined && toolCallId !== null) {
    if (typeof toolCallId !== "string") throw new ValidationError(`"${at}.tool_call_id" must be a string`);
    message.toolCallId = toolCallId;
  } else if (role === "tool") {
    throw new ValidationError(`"${at}.tool_call_id" is required for role "tool" messages`);
  }
  const toolCalls = value["tool_calls"];
  if (toolCalls !== undefined && toolCalls !== null) {
    if (!Array.isArray(toolCalls)) throw new ValidationError(`"${at}.tool_calls" must be an array`);
    message.toolCalls = toolCalls.map((call, callIndex) =>
      openAIToolCallToIR(call, `${at}.tool_calls[${callIndex}]`),
    );
  }
  return message;
}

function openAIToolCallToIR(value: unknown, at: string): ToolCall {
  if (!isRecord(value)) throw new ValidationError(`"${at}" must be an object`);
  const id = value["id"];
  if (typeof id !== "string" || id.length === 0) {
    throw new ValidationError(`"${at}.id" must be a non-empty string`);
  }
  if (value["type"] !== undefined && value["type"] !== "function") {
    throw new ValidationError(`"${at}.type" must be "function"`);
  }
  const fn = value["function"];
  if (!isRecord(fn)) throw new ValidationError(`"${at}.function" must be an object`);
  const name = fn["name"];
  if (typeof name !== "string" || name.length === 0) {
    throw new ValidationError(`"${at}.function.name" must be a non-empty string`);
  }
  let argsRaw = fn["arguments"];
  if (argsRaw === undefined || argsRaw === null) argsRaw = "{}";
  if (typeof argsRaw !== "string") {
    throw new ValidationError(`"${at}.function.arguments" must be a JSON string`);
  }
  return { id, name, arguments: argsRaw };
}

function openAIToolToIR(value: unknown, index: number): ToolSpec {
  const at = `tools[${index}]`;
  if (!isRecord(value)) throw new ValidationError(`"${at}" must be an object`);
  if (value["type"] !== undefined && value["type"] !== "function") {
    throw new ValidationError(`"${at}.type" must be "function"`);
  }
  const fn = value["function"];
  if (!isRecord(fn)) throw new ValidationError(`"${at}.function" must be an object`);
  const name = fn["name"];
  if (typeof name !== "string" || name.length === 0) {
    throw new ValidationError(`"${at}.function.name" must be a non-empty string`);
  }
  const tool: ToolSpec = { name, parameters: {} };
  const description = fn["description"];
  if (description !== undefined && description !== null) {
    if (typeof description !== "string") {
      throw new ValidationError(`"${at}.function.description" must be a string`);
    }
    tool.description = description;
  }
  const parameters = fn["parameters"];
  if (parameters !== undefined && parameters !== null) {
    if (!isRecord(parameters)) {
      throw new ValidationError(`"${at}.function.parameters" must be a JSON schema object`);
    }
    tool.parameters = parameters;
  } else {
    tool.parameters = {};
  }
  return tool;
}

/**
 * Parse one OpenAI SSE chunk into an IR chunk.
 *
 * Never throws: an unrecognized payload degrades to `{ index }` so a single
 * malformed line cannot kill a stream. Tool-call deltas are parsed
 * defensively into IR `toolCalls` (see `parseToolCallDeltas`); malformed
 * entries are skipped rather than fatal.
 */
export function openAIChunkToIR(chunk: unknown): IRChunk {
  if (!isRecord(chunk)) return { index: 0 };
  const choices = chunk["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return { index: 0 };
  const first = choices[0];
  if (!isRecord(first)) return { index: 0 };
  const index = typeof first["index"] === "number" ? first["index"] : 0;

  const delta = first["delta"];
  let role: Role | undefined;
  let content: string | undefined;
  let toolCalls: ToolCallDelta[] | undefined;
  if (isRecord(delta)) {
    const deltaRole = delta["role"];
    if (typeof deltaRole === "string" && ROLES.includes(deltaRole)) role = deltaRole as Role;
    const deltaContent = delta["content"];
    if (typeof deltaContent === "string" && deltaContent.length > 0) content = deltaContent;
    toolCalls = parseToolCallDeltas(delta["tool_calls"]);
  }

  const rawFinish = first["finish_reason"];
  const finishReason =
    rawFinish === "stop" || rawFinish === "length" || rawFinish === "tool_calls" ? rawFinish : null;

  const done = finishReason !== null ? true : chunk["done"] === true;
  const out: IRChunk = { index };
  if (role !== undefined) out.role = role;
  if (content !== undefined) out.content = content;
  if (toolCalls !== undefined) out.toolCalls = toolCalls;
  out.finishReason = finishReason;
  if (done) out.done = true;
  return out;
}

/**
 * Parse a `delta.tool_calls` array into IR tool-call deltas, defensively:
 * non-object entries and entries with unusable fields are skipped, a missing
 * `index` falls back to the array position, and a missing `function` object
 * is tolerated (the delta may carry only `id`). Returns `undefined` when no
 * delta parses at all, so empty/malformed arrays do not add a `toolCalls`
 * field to the chunk.
 */
function parseToolCallDeltas(raw: unknown): ToolCallDelta[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ToolCallDelta[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!isRecord(entry)) continue;
    const rawIndex = entry["index"];
    if (rawIndex !== undefined && (typeof rawIndex !== "number" || !Number.isInteger(rawIndex) || rawIndex < 0)) {
      continue;
    }
    const delta: ToolCallDelta = { index: typeof rawIndex === "number" ? rawIndex : i };
    const id = entry["id"];
    if (typeof id === "string" && id.length > 0) delta.id = id;
    const fn = entry["function"];
    if (isRecord(fn)) {
      const name = fn["name"];
      if (typeof name === "string" && name.length > 0) delta.name = name;
      const args = fn["arguments"];
      if (typeof args === "string" && args.length > 0) delta.arguments = args;
    }
    out.push(delta);
  }
  return out.length > 0 ? out : undefined;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

function nextChunkId(): string {
  return `chatcmpl-${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
