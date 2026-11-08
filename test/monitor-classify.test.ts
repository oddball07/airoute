import { classifyError } from "@airoute/monitor";
import { describe, expect, it } from "vitest";

describe("classifyError", () => {
  it("classifies live-observed provider strings", () => {
    // ZAI free-tier flap (glm-4.7-flash, verified live 2026-11-08):
    expect(classifyError("The service may be temporarily overloaded")).toBe("capacity");
    expect(
      classifyError("429: The service may be temporarily overloaded, please try again later"),
    ).toBe("capacity");
    // OpenRouter dead upstream models 429 as "Provider returned error".
    expect(classifyError("Provider returned error")).toBe("server");
    expect(classifyError("rate_limited; Provider returned error")).toBe("server");
    // OpenRouter insufficient balance (verified live wording).
    expect(classifyError("Insufficient balance or no resource package")).toBe("auth");
    // Kit timeout message (probeErrorLabel short-circuits to "timeout", the
    // raw message still classifies via its phrasing).
    expect(classifyError("upstream did not respond within 60000ms")).toBe("timeout");
    expect(classifyError("upstream did not complete within 120000ms")).toBe("timeout");
    expect(classifyError("upstream stream was idle for more than 48000ms")).toBe("timeout");
  });

  it("classifies the compat-kit short probe labels", () => {
    expect(classifyError("rate_limited")).toBe("rate_limited");
    expect(classifyError("rate_limit_exceeded")).toBe("rate_limited");
    expect(classifyError("rate_limit_error")).toBe("rate_limited");
    expect(classifyError("timeout")).toBe("timeout");
    expect(classifyError("network_error")).toBe("network");
    expect(classifyError("http_502")).toBe("server");
    expect(classifyError("http_503")).toBe("server");
    expect(classifyError("http_429")).toBe("rate_limited");
    expect(classifyError("http_401")).toBe("auth");
    expect(classifyError("http_403")).toBe("auth");
    expect(classifyError("http_504")).toBe("timeout");
    expect(classifyError("probe_failed")).toBe("unknown");
  });

  it("classifies generic phrasing and thrown errors", () => {
    expect(classifyError("fetch failed")).toBe("network");
    expect(classifyError(new Error("connect ECONNRESET 127.0.0.1:443"))).toBe("network");
    expect(classifyError(new Error("getaddrinfo ENOTFOUND api.example.com"))).toBe("network");
    expect(classifyError("operation timed out")).toBe("timeout");
    expect(classifyError("Insufficient_quota: You exceeded your current quota")).toBe("auth");
    expect(classifyError("invalid_api_key")).toBe("auth");
    expect(classifyError("invalid api key")).toBe("auth");
    expect(classifyError("balance is too low")).toBe("auth");
    expect(classifyError("nothing recognizable here")).toBe("unknown");
    expect(classifyError(undefined)).toBe("unknown");
    expect(classifyError(null)).toBe("unknown");
    expect(classifyError("")).toBe("unknown");
    expect(classifyError(42)).toBe("unknown");
  });

  it("prefers family clues over weaker ones (precedence)", () => {
    // "overloaded" beats "rate_l" — a ZAI 429 whose detail says overloaded
    // is capacity, not account shaping.
    expect(classifyError("rate_limited: The service may be temporarily overloaded")).toBe(
      "capacity",
    );
    // "provider returned error" beats "rate_l" — OpenRouter dead-upstream 429s.
    expect(classifyError("rate_limit_exceeded: Provider returned error")).toBe("server");
  });

  it("digs strings out of error-shaped objects", () => {
    expect(classifyError({ error: "rate_limited" })).toBe("rate_limited");
    expect(classifyError({ message: "upstream did not respond within 60000ms" })).toBe("timeout");
    expect(classifyError({ code: "insufficient_quota" })).toBe("auth");
    expect(classifyError({ error: 42 })).toBe("unknown");
  });
});
