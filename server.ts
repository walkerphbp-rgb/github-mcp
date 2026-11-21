// Node HTTP wrapper around the Worker-style handler in index.ts (for Render).
import http from "node:http";
import type { IncomingMessage } from "node:http";
import worker from "./index";
import type { Env } from "./github";

const MAX_BODY = 64 * 1024;
const HOP_BY_HOP = new Set(["connection", "content-length", "transfer-encoding", "host", "keep-alive", "upgrade"]);

// Fail closed: refuse to start without every required value.
export function loadEnv(src: Record<string, string | undefined> = process.env): Env {
  const { MCP_AUTH_TOKEN, GITHUB_TOKEN, ALLOWED_REPOS } = src;
  if (!MCP_AUTH_TOKEN || MCP_AUTH_TOKEN.length < 24) throw new Error("MCP_AUTH_TOKEN is required (at least 24 characters)");
  if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required");
  if (!ALLOWED_REPOS || !ALLOWED_REPOS.trim()) throw new Error("ALLOWED_REPOS is required (comma-separated owner/repo)");
  return { MCP_AUTH_TOKEN, GITHUB_TOKEN, ALLOWED_REPOS };
}

// Returns null when the body exceeds the limit.
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function send(res: http.ServerResponse, status: number, body: string, type = "text/plain", extra: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": type, ...extra });
  res.end(body);
}

export function createApp(env: Env): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      // Unauthenticated liveness check; reveals nothing.
      if (url.pathname === "/health" && (req.method === "GET" || req.method === "HEAD")) {
        return send(res, 200, JSON.stringify({ ok: true }), "application/json");
      }

      let body: Buffer | undefined;
      if (req.method === "POST") {
        const raw = await readBody(req, MAX_BODY);
        if (!raw) {
          res.writeHead(413, { "content-type": "text/plain", connection: "close" });
          return res.end("Request too large", () => req.destroy());
        }
        body = raw;
      }

      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v !== undefined && !HOP_BY_HOP.has(k)) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      }
      const request = new Request(url, { method: req.method, headers, body: body && body.length ? new Uint8Array(body) : undefined });

      const response = await worker.fetch(request, env);
      const out: Record<string, string> = {};
      response.headers.forEach((v, k) => (out[k] = v));
      res.writeHead(response.status, out);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      // Never echo error details, request bodies, or tokens.
      if (!res.headersSent) send(res, 500, "Internal error");
      else res.end();
    }
  });
}
