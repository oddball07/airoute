import { describe, expect, it } from "vitest";
import { clientConnectableGatewayUrl } from "../packages/cli/src/gateway-url.js";

describe("clientConnectableGatewayUrl", () => {
  it("substitutes bind-anywhere hosts with the loopback address", () => {
    expect(clientConnectableGatewayUrl("0.0.0.0", 8787)).toBe("http://127.0.0.1:8787");
    expect(clientConnectableGatewayUrl("::", 8787)).toBe("http://127.0.0.1:8787");
  });

  it("preserves explicit hosts verbatim", () => {
    expect(clientConnectableGatewayUrl("127.0.0.1", 8787)).toBe("http://127.0.0.1:8787");
    expect(clientConnectableGatewayUrl("192.168.1.10", 8787)).toBe("http://192.168.1.10:8787");
    expect(clientConnectableGatewayUrl("localhost", "8787")).toBe("http://localhost:8787");
  });

  it("brackets IPv6 literals", () => {
    expect(clientConnectableGatewayUrl("::1", 8787)).toBe("http://[::1]:8787");
  });
});
