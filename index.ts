import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Env } from "./github";
import { buildServer } from "./tools";

const MAX_BODY = 64 * 1024;

async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

// Constant-time comparison: hash both sides, then compare without early exit.
async function validToken(header: string | null, expected: string): Promise<boolean> {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m) return false;
  const [a, b] = await Promise.all([digest(m[1]), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const text = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "content-type": "text/plain", ...headers } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/mcp") return text(404, "Not found");

    // Fail closed if misconfigured, without revealing which value is missing.
    if (!env.MCP_AUTH_TOKEN || !env.GITHUB_TOKEN || !env.ALLOWED_REPOS) return text(500, "Server misconfigured");

    // Auth runs before method handling so every method is covered.
    if (!(await validToken(request.headers.get("authorization"), env.MCP_AUTH_TOKEN))) return text(401, "Unauthorized");

    // Stateless server: no SSE stream and no sessions, so only POST is served.
    if (request.method !== "POST") return text(405, "Method not allowed", { allow: "POST" });

    // Enforce the size cap on the actual body (content-length can be absent or wrong).
    const raw = await request.text();
    if (raw.length > MAX_BODY) return text(413, "Request too large");
    request = new Request(request.url, { method: "POST", headers: request.headers, body: raw });

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await buildServer(env).connect(transport);
    return transport.handleRequest(request);
  },
};
