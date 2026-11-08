/**
 * Tool-call delta mapping tests for `openai-wire.ts` — `openAIChunkToIR`
 * (wire → IR, defensive parsing) and `irChunkToOpenAIChunk` (IR → wire,
 * round-trip). Fully offline.
 */
import { irChunkToOpenAIChunk, openAIChunkToIR, type IRChunk } from "@airoute/core";
import { describe, expect, it } from "vitest";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function wireChunk(delta: Record<string, unknown>, finish: unknown = null): unknown {
  return {
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "m1",
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

/* -------------------------------------------------------------------------- */
/* openAIChunkToIR — wire tool_calls → IR toolCalls                           */
/* -------------------------------------------------------------------------- */

describe("openAIChunkToIR — tool-call deltas", () => {
  it("parses a single tool-call delta", () => {
    const chunk = openAIChunkToIR(
      wireChunk({
        tool_calls: [
          { index: 0, id: "call_x", type: "function", function: { name: "get_weather", arguments: "{\"location\":" } },
        ],
      }),
    );
    expect(chunk.toolCalls).toEqual([
      { index: 0, id: "call_x", name: "get_weather", arguments: "{\"location\":" },
    ]);
  });

  it("parses multi-index deltas keyed by their index", () => {
    const chunk = openAIChunkToIR(
      wireChunk({
        tool_calls: [
          { index: 0, id: "call_x", type: "function", function: { name: "get_weather", arguments: "{\"location\":" } },
          { index: 1, id: "call_y", function: { name: "get_time" } },
          { index: 0, function: { arguments: "\"Paris\"}" } },
        ],
      }),
    );
    expect(chunk.toolCalls).toEqual([
      { index: 0, id: "call_x", name: "get_weather", arguments: "{\"location\":" },
      { index: 1, id: "call_y", name: "get_time" },
      { index: 0, arguments: "\"Paris\"}" },
    ]);
  });

  it("falls back to the array position when index is missing", () => {
    const chunk = openAIChunkToIR(
      wireChunk({
        tool_calls: [
          { id: "call_a", function: { name: "f_a", arguments: "1" } },
          { id: "call_b", function: { name: "f_b", arguments: "2" } },
        ],
      }),
    );
    expect(chunk.toolCalls).toEqual([
      { index: 0, id: "call_a", name: "f_a", arguments: "1" },
      { index: 1, id: "call_b", name: "f_b", arguments: "2" },
    ]);
  });

  it("tolerates malformed entries (non-objects, bad index, no function)", () => {
    const chunk = openAIChunkToIR(
      wireChunk({
        tool_calls: [
          "nope",
          42,
          { id: "id_only" }, // missing function → but a valid id-only delta
          { index: 1, function: { arguments: "{}" } }, // no id/name — still a parseable delta
          { index: "bad", function: { name: "skipme" } }, // unusable index → skipped
        ],
      }),
    );
    expect(chunk.toolCalls).toEqual([
      { index: 2, id: "id_only" },
      { index: 1, arguments: "{}" },
    ]);
  });

  it("omits toolCalls entirely for an empty or non-array tool_calls", () => {
    expect(openAIChunkToIR(wireChunk({ tool_calls: [] })).toolCalls).toBeUndefined();
    expect(openAIChunkToIR(wireChunk({ tool_calls: "garbage" })).toolCalls).toBeUndefined();
    expect(openAIChunkToIR(wireChunk({})).toolCalls).toBeUndefined();
  });

  it("keeps role/content/finish bookkeeping alongside tool calls", () => {
    const chunk = openAIChunkToIR(
      wireChunk(
        { role: "assistant", content: "", tool_calls: [{ index: 0, id: "c", function: { name: "f" } }] },
        "tool_calls",
      ),
    );
    expect(chunk).toMatchObject({
      index: 0,
      role: "assistant",
      finishReason: "tool_calls",
      done: true,
    });
    expect(chunk.content).toBeUndefined(); // empty content delta stays absent
    expect(chunk.toolCalls).toEqual([{ index: 0, id: "c", name: "f" }]);
  });

  it("preserves non-tool traffic byte-for-byte semantics (no tool_calls field)", () => {
    const chunk = openAIChunkToIR(wireChunk({ role: "assistant", content: "hi" }, "stop"));
    expect(chunk).toEqual({ index: 0, role: "assistant", content: "hi", finishReason: "stop", done: true });
    expect("toolCalls" in chunk).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* irChunkToOpenAIChunk — IR toolCalls → wire delta.tool_calls                */
/* -------------------------------------------------------------------------- */

describe("irChunkToOpenAIChunk — tool-call deltas", () => {
  it("round-trips an IR chunk's toolCalls into delta.tool_calls", () => {
    const ir: IRChunk = {
      index: 1,
      toolCalls: [{ index: 0, id: "call_x", name: "get_weather", arguments: "{\"location\":" }],
    };
    const wire = irChunkToOpenAIChunk(ir, "m1");
    expect(wire.choices[0]!.delta.tool_calls).toEqual([
      { index: 0, type: "function", id: "call_x", function: { name: "get_weather", arguments: "{\"location\":" } },
    ]);
    // openAIChunkToIR reads it back into the same IR deltas
    const parsed = openAIChunkToIR(wire);
    expect(parsed.toolCalls).toEqual([{ index: 0, id: "call_x", name: "get_weather", arguments: "{\"location\":" }]);
  });

  it("includes only defined id/function fields and preserves indexes", () => {
    const wire = irChunkToOpenAIChunk({ index: 3, toolCalls: [{ index: 7, arguments: "…tail" }] }, "m1");
    expect(wire.choices[0]!.delta.tool_calls).toEqual([
      { index: 7, type: "function", function: { arguments: "…tail" } },
    ]);
    const bare = irChunkToOpenAIChunk({ index: 0, toolCalls: [{ index: 2, id: "z" }] }, "m1");
    expect(bare.choices[0]!.delta.tool_calls).toEqual([{ index: 2, type: "function", id: "z" }]);
  });

  it("round-trips multiple indexes in order", () => {
    const wire = irChunkToOpenAIChunk(
      {
        index: 0,
        toolCalls: [
          { index: 1, id: "b", name: "second", arguments: "{" },
          { index: 0, id: "a", name: "first", arguments: "{}" },
        ],
      },
      "m1",
    );
    const parsed = openAIChunkToIR(wire);
    expect(parsed.toolCalls).toEqual([
      { index: 1, id: "b", name: "second", arguments: "{" },
      { index: 0, id: "a", name: "first", arguments: "{}" },
    ]);
  });

  it("leaves plain content chunks untouched", () => {
    const wire = irChunkToOpenAIChunk({ index: 0, role: "assistant", content: "hi" }, "m1");
    expect(wire.choices[0]!.delta).toEqual({ role: "assistant", content: "hi" });
    expect(wire.choices[0]!.delta.tool_calls).toBeUndefined();
  });

  it("always emits choice index 0, not the IR chunk sequence number", () => {
    const toolChunk = irChunkToOpenAIChunk(
      { index: 12, toolCalls: [{ index: 0, id: "c", name: "f", arguments: "{}" }] },
      "m1",
    );
    const terminal = irChunkToOpenAIChunk({ index: 13, finishReason: "tool_calls" }, "m1");
    expect(toolChunk.choices[0]!.index).toBe(0);
    expect(terminal.choices[0]!.index).toBe(0);
  });
});
