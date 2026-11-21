import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "../src/index";

const env = { MCP_AUTH_TOKEN: "test-token-123", GITHUB_TOKEN: "ghp_fake_secret", ALLOWED_REPOS: "octo/allowed,Octo/Other" };
const URL_ = "https://w.example/mcp";
const auth = { authorization: `Bearer ${env.MCP_AUTH_TOKEN}` };

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

async function rpc(method: string, params: unknown, headers: Record<string, string> = auth, e = env) {
  const res = await worker.fetch(
    new Request(URL_, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
    e,
  );
  return res;
}

// Calls a tool and normalises protocol-level and tool-level errors into one shape.
async function call(name: string, args: Record<string, unknown>) {
  const res = await rpc("tools/call", { name, arguments: args });
  const body: any = await res.json();
  if (body.error) return { isError: true, text: String(body.error.message) };
  return { isError: !!body.result.isError, text: String(body.result.content?.[0]?.text ?? "") };
}

describe("authentication", () => {
  it.each(["POST", "GET", "DELETE", "OPTIONS", "PUT", "PATCH", "HEAD"])("%s without token -> 401", async (method) => {
    const res = await worker.fetch(new Request(URL_, { method, body: ["POST", "PUT", "PATCH"].includes(method) ? "{}" : undefined }), env);
    expect(res.status).toBe(401);
  });

  it("wrong, malformed and non-Bearer tokens -> 401", async () => {
    for (const h of ["Bearer wrong", "test-token-123", "Basic dGVzdDp0ZXN0", "Bearer "]) {
      expect((await rpc("tools/list", {}, { authorization: h })).status).toBe(401);
    }
  });

  it("valid token, non-POST methods -> 405 with Allow: POST", async () => {
    for (const method of ["GET", "DELETE", "OPTIONS"]) {
      const res = await worker.fetch(new Request(URL_, { method, headers: auth }), env);
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  it("valid token, POST initialize -> 200", async () => {
    const res = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(res.status).toBe(200);
  });

  it("unknown path -> 404; missing config fails closed with 500", async () => {
    expect((await worker.fetch(new Request("https://w.example/other", { method: "POST", headers: auth }), env)).status).toBe(404);
    expect((await rpc("tools/list", {}, auth, { ...env, MCP_AUTH_TOKEN: "" })).status).toBe(500);
  });

  it("oversized request body -> 413", async () => {
    const res = await worker.fetch(new Request(URL_, { method: "POST", headers: auth, body: "x".repeat(70_000) }), env);
    expect(res.status).toBe(413);
  });
});

describe("tools", () => {
  it("lists exactly the six read-only tools", async () => {
    const body: any = await (await rpc("tools/list", {})).json();
    expect(body.result.tools.map((t: any) => t.name).sort()).toEqual(
      ["get_contents", "get_issue", "get_pull_request", "list_issues", "list_pull_requests", "search_code"],
    );
  });
});

describe("repository allowlist", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["get_contents", { path: "" }],
    ["search_code", { query: "foo" }],
    ["list_issues", {}],
    ["get_issue", { number: 1 }],
    ["list_pull_requests", {}],
    ["get_pull_request", { number: 1 }],
  ];
  it.each(cases)("%s rejects a non-allowlisted repo without calling GitHub", async (name, extra) => {
    const r = await call(name, { owner: "evil", repo: "secrets", ...extra });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/allowlist/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("matches the allowlist case-insensitively and only calls the fixed host with the PAT", async () => {
    fetchMock.mockResolvedValue(json([]));
    const r = await call("list_issues", { owner: "OCTO", repo: "Allowed" });
    expect(r.isError).toBe(false);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url).startsWith("https://api.github.com/repos/OCTO/Allowed/issues")).toBe(true);
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer ghp_fake_secret" });
  });
});

describe("input validation", () => {
  const base = { owner: "octo", repo: "allowed" };
  it.each([
    ["get_contents", { path: "../etc/passwd" }],
    ["get_contents", { path: "a/../../b" }],
    ["get_contents", { path: "/abs" }],
    ["get_contents", { path: "a\\b" }],
    ["get_contents", { path: "", ref: "main..evil" }],
    ["list_issues", { per_page: 500 }],
    ["list_issues", { state: "bogus" }],
    ["get_issue", { number: 0 }],
    ["get_issue", { number: -4 }],
    ["get_pull_request", { number: 1.5 }],
    ["search_code", { query: "x repo:other/private" }],
    ["search_code", { query: "x -org:foo" }],
    ["search_code", { query: "" }],
  ])("%s rejects %j", async (name, extra) => {
    const r = await call(name, { ...base, ...extra });
    expect(r.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid owner characters", async () => {
    expect((await call("list_issues", { owner: "octo/../x", repo: "allowed" })).isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("output handling", () => {
  const base = { owner: "octo", repo: "allowed" };
  const b64 = (s: string | Uint8Array) =>
    btoa(typeof s === "string" ? s : Array.from(s, (b) => String.fromCharCode(b)).join(""));

  it("truncates large files explicitly", async () => {
    fetchMock.mockResolvedValue(json({ type: "file", path: "big.txt", size: 90000, sha: "s", encoding: "base64", content: b64("a".repeat(90_000)) }));
    const r = await call("get_contents", { ...base, path: "big.txt" });
    const out = JSON.parse(r.text);
    expect(out.truncated).toBe(true);
    expect(out.content.length).toBe(40_000);
  });

  it("returns metadata only for binary files", async () => {
    fetchMock.mockResolvedValue(json({ type: "file", path: "x.bin", size: 4, sha: "s", encoding: "base64", content: b64(new Uint8Array([0xff, 0xfe, 0x00, 0x80])) }));
    const out = JSON.parse((await call("get_contents", { ...base, path: "x.bin" })).text);
    expect(out.content).toBeUndefined();
    expect(out.note).toMatch(/Binary/);
  });

  it("truncates long issue bodies and comments, filters PRs from list_issues", async () => {
    fetchMock.mockResolvedValueOnce(json({ number: 1, title: "t", state: "open", body: "b".repeat(30_000), user: { login: "u" } }));
    fetchMock.mockResolvedValueOnce(json(Array.from({ length: 20 }, () => ({ user: { login: "c" }, body: "c".repeat(20_000) }))));
    const r = await call("get_issue", { ...base, number: 1, include_comments: true });
    expect(r.text).not.toContain("[output truncated]");
    const out = JSON.parse(r.text);
    expect(out.body_truncated).toBe(true);
    expect(out.body.length).toBe(10_000);
    expect(out.comments).toHaveLength(20);
    expect(out.comments[0].body.length).toBe(1500);
    expect(r.text.length).toBeLessThan(50_000);

    fetchMock.mockResolvedValueOnce(json([{ number: 1, title: "issue" }, { number: 2, title: "pr", pull_request: {} }]));
    const list = JSON.parse((await call("list_issues", base)).text);
    expect(list.map((i: any) => i.number)).toEqual([1]);
  });

  it("search_code drops results from other repositories", async () => {
    fetchMock.mockResolvedValue(json({ total_count: 2, items: [
      { path: "a.ts", html_url: "u1", repository: { full_name: "octo/allowed" } },
      { path: "b.ts", html_url: "u2", repository: { full_name: "other/repo" } },
    ] }));
    const out = JSON.parse((await call("search_code", { ...base, query: "foo" })).text);
    expect(out.results.map((r: any) => r.path)).toEqual(["a.ts"]);
    expect(decodeURIComponent(String(fetchMock.mock.calls[0][0]))).toContain("repo:octo/allowed");
  });

  it("get_pull_request returns files list without patches", async () => {
    fetchMock.mockResolvedValueOnce(json({ number: 3, title: "pr", state: "open", changed_files: 1, body: "hi" }));
    fetchMock.mockResolvedValueOnce(json([{ filename: "a.ts", status: "modified", additions: 1, deletions: 0, patch: "SECRETPATCH" }]));
    const r = await call("get_pull_request", { ...base, number: 3 });
    expect(r.text).not.toContain("SECRETPATCH");
    expect(JSON.parse(r.text).files[0].filename).toBe("a.ts");
  });
});

describe("error handling", () => {
  const base = { owner: "octo", repo: "allowed" };
  const spies = () => [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];

  it("maps 404, 401, rate limit and 5xx to safe messages", async () => {
    fetchMock.mockResolvedValueOnce(json({ message: "Not Found" }, 404));
    expect((await call("get_issue", { ...base, number: 9 })).text).toMatch(/Not found/);

    fetchMock.mockResolvedValueOnce(json({ message: "Bad credentials ghp_fake_secret" }, 401));
    const unauth = await call("get_issue", { ...base, number: 9 });
    expect(unauth.text).toMatch(/rejected/);
    expect(unauth.text).not.toContain("ghp_fake_secret");

    fetchMock.mockResolvedValueOnce(json({}, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" }));
    const rl = await call("get_issue", { ...base, number: 9 });
    expect(rl.text).toMatch(/rate limit.*2030-01-01/);

    fetchMock.mockResolvedValueOnce(json({ message: "boom <secret internals>" }, 502));
    const e5 = await call("get_issue", { ...base, number: 9 });
    expect(e5.text).toBe("GitHub error (HTTP 502)");
  });

  it("network failure and unexpected exceptions return generic errors", async () => {
    fetchMock.mockRejectedValueOnce(new Error("socket ghp_fake_secret"));
    const r = await call("get_issue", { ...base, number: 9 });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("ghp_fake_secret");
  });

  it("never logs tokens or request bodies", async () => {
    const s = spies();
    fetchMock.mockResolvedValue(json([]));
    await call("list_issues", base);
    await rpc("tools/list", {}, { authorization: "Bearer nope" });
    for (const spy of s) for (const args of spy.mock.calls) {
      expect(JSON.stringify(args)).not.toMatch(/ghp_fake_secret|test-token-123|nope/);
    }
    s.forEach((x) => x.mockRestore());
  });
});
