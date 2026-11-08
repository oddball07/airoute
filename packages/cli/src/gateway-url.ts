/**
 * Pure helpers for composing the gateway URL written into client configs.
 *
 * A bind address is not an address a client can connect to: `0.0.0.0` and `::`
 * mean "all interfaces". When the gateway config binds to one of them, the
 * URL handed to clients (e.g. `opencode.json`) must instead point at the
 * loopback interface on the same host.
 */

/**
 * Substitute a client-unconnectable bind host (`0.0.0.0`, `::`) with
 * `127.0.0.1` for URL composition. Any explicit host is preserved verbatim.
 * IPv6 literals are bracketed per RFC 3986 host syntax.
 */
export function clientConnectableGatewayUrl(host: string, port: number | string): string {
  const loopback = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const literal = loopback.includes(":") ? `[${loopback}]` : loopback;
  return `http://${literal}:${port}`;
}
