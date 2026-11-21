import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApp, loadEnv } from "../src/server";

const TOKEN = "a-long-random-test-token-0123456789";
const env = { MCP_AUTH_TOKEN: TOKEN, GITHUB_TOKEN: "ghp_fake_secret", ALLOWED_REPOS: "octo/allowed" };
const auth = { authorization: `Bearer ${TOKEN}` };

let server: http.Server;
let port: number;
let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  server = createApp(env);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock); // upstream GitHub only; the test client uses node:http
});

// Real HTTP over loopback, so the Node wrapper is exercised, not just the handler.
function call(method: string, path: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const rpcHeaders = { ...auth, "content-type": "application/json", accept: "application/json, text/event-stream" };
const rpc = (method: string, params: unknown = {}) =>
  call("POST", "/mcp", rpcHeaders, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));

describe("startup config", () => {
  it("refuses to start without required values", () => {
    expect(() => loadEnv({})).toThrow(/MCP_AUTH_TOKEN/);
    expect(() => loadEnv({ ...env, MCP_AUTH_TOKEN: "short" })).toThrow(/24 characters/);
    expect(() => loadEnv({ ...env, GITHUB_TOKEN: "" })).toThrow(/GITHUB_TOKEN/);
    expect(() => loadEnv({ ...env, ALLOWED_REPOS: "  " })).toThrow(/ALLOWED_REPOS/);
  });
  it("accepts a complete config", () => {
    expect(loadEnv(env)).toEqual(env);
  });
});

describe("HTTP wrapper", () => {
  it("/health is open and reveals nothing", async () => {
    const r = await call("GET", "/health");
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ ok: true });
    expect(r.text).not.toMatch(/ghp_|allowed|octo/);
  });

  it("unknown path -> 404", async () => {
    expect((await call("GET", "/nope", auth)).status).toBe(404);
  });

  it.each(["POST", "GET", "DELETE", "OPTIONS", "PUT", "PATCH"])("%s /mcp without token -> 401", async (m) => {
    expect((await call(m, "/mcp", {}, m === "POST" || m === "PUT" || m === "PATCH" ? "{}" : undefined)).status).toBe(401);
  });

  it("wrong token -> 401", async () => {
    expect((await call("POST", "/mcp", { authorization: "Bearer wrong" }, "{}")).status).toBe(401);
  });

  it.each(["GET", "DELETE", "OPTIONS"])("%s /mcp with token -> 405", async (m) => {
    const r = await call(m, "/mcp", auth);
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe("POST");
  });

  it("serves the six tools over real HTTP", async () => {
    const r = await rpc("tools/list");
    expect(r.status).toBe(200);
    const names = JSON.parse(r.text).result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(["get_contents", "get_issue", "get_pull_request", "list_issues", "list_pull_requests", "search_code"]);
  });

  it("calls a tool end to end (GitHub stubbed) and keeps the PAT server-side", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify([{ number: 7, title: "hello", state: "open" }]), { status: 200 }));
    const r = await rpc("tools/call", { name: "list_issues", arguments: { owner: "octo", repo: "allowed" } });
    expect(r.status).toBe(200);
    expect(r.text).toContain("hello");
    expect(r.text).not.toContain("ghp_fake_secret");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url).startsWith("https://api.github.com/repos/octo/allowed/issues")).toBe(true);
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer ghp_fake_secret" });
  });

  it("rejects a non-allowlisted repo without calling GitHub", async () => {
    const r = await rpc("tools/call", { name: "get_issue", arguments: { owner: "evil", repo: "x", number: 1 } });
    expect(r.text).toMatch(/allowlist/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("oversized body -> 413 and the server stays up", async () => {
    const r = await call("POST", "/mcp", rpcHeaders, "x".repeat(70_000)).catch(() => ({ status: 413 }));
    expect(r.status).toBe(413);
    expect((await call("GET", "/health")).status).toBe(200);
  });

  it("malformed JSON gets a client error, not a crash", async () => {
    const r = await call("POST", "/mcp", rpcHeaders, "not json {");
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect((await call("GET", "/health")).status).toBe(200);
  });

  it("never logs tokens", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    fetchMock.mockResolvedValue(new Response("[]", { status: 200 }));
    await rpc("tools/call", { name: "list_issues", arguments: { owner: "octo", repo: "allowed" } });
    await call("POST", "/mcp", { authorization: "Bearer nope" }, "{}");
    for (const s of spies) for (const a of s.mock.calls) expect(JSON.stringify(a)).not.toMatch(/ghp_fake_secret|a-long-random|nope/);
    spies.forEach((s) => s.mockRestore());
  });
});
