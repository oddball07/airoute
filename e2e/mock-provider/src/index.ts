/**
 * @airoute/mock-provider — deterministic test double for AIRoute.
 *
 * Two faces, one engine:
 * 1. `startMockProvider()` / `createMockApp()` — an OpenAI-compatible HTTP
 *    server for exercising real source plugins against a fake provider.
 *    Scenario via the `x-mock-scenario` header (or fixed at construction).
 * 2. `createMockSource()` — a `Source` implementing the AIRoute interface for
 *    direct registry injection in in-process tests.
 */
export * from "./engine.js";
export * from "./source.js";
export * from "./app.js";
