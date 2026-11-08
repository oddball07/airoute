import { describe, expect, it } from "vitest";
import { parseJsonc } from "../packages/opencode/src/jsonc.js";

describe("parseJsonc", () => {
  it("accepts a trailing comma followed by a line comment before the brace", () => {
    expect(parseJsonc('{"a":1, // trailing comment\n}')).toEqual({ a: 1 });
    expect(parseJsonc('[1, // note\n]')).toEqual([1]);
  });

  it("accepts a trailing comma followed by a block comment before the brace", () => {
    expect(parseJsonc('{"a":1, /* block */}')).toEqual({ a: 1 });
    expect(parseJsonc("[1, /* block */ ]")).toEqual([1]);
  });

  it("keeps accepting plain trailing commas and regular use", () => {
    expect(parseJsonc('{"a":1,}')).toEqual({ a: 1 });
    expect(parseJsonc("[1,2,]")).toEqual([1, 2]);
    expect(parseJsonc('{"a":1,"b":{"c":2,}}')).toEqual({ a: 1, b: { c: 2 } });
  });

  it("preserves comments inside string literals", () => {
    const parsed = parseJsonc(
      '{"url": "http://x", "weird": "/* not a comment */"}',
    ) as Record<string, string>;
    expect(parsed["url"]).toBe("http://x");
    expect(parsed["weird"]).toBe("/* not a comment */");
  });

  it("parses `// comment` at EOF without a newline", () => {
    expect(parseJsonc('{"a":1} // end comment')).toEqual({ a: 1 });
  });

  it("still throws on invalid input, naming the line/offset", () => {
    expect(() => parseJsonc('{"a": 1\n"b": 2}')).toThrow(/invalid JSONC.*line 2/);
    expect(() => parseJsonc("{")).toThrow(/invalid JSONC/);
  });
});
