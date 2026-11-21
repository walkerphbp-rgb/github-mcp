// GitHub access: fixed host, allowlist guard, input validation, caps, error mapping.

export interface Env {
  MCP_AUTH_TOKEN: string;
  GITHUB_TOKEN: string;
  ALLOWED_REPOS: string;
}

export class ToolError extends Error {}

const API = "https://api.github.com"; // fixed host; never taken from input
export const MAX_OUTPUT = 50_000;

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9_./-]{1,200}$/;

export function assertRepo(env: Env, owner: string, repo: string): void {
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) throw new ToolError("Invalid owner or repo name");
  const allowed = (env.ALLOWED_REPOS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.includes(`${owner}/${repo}`.toLowerCase())) {
    throw new ToolError("Repository is not in the allowlist");
  }
}

export function checkPath(path: string): string {
  if (path.length > 500 || /[\\\x00-\x1f]/.test(path) || path.startsWith("/")) {
    throw new ToolError("Invalid path");
  }
  const segs = path.split("/").filter(Boolean);
  if (segs.some((s) => s === "." || s === "..")) throw new ToolError("Invalid path");
  return segs.map(encodeURIComponent).join("/");
}

export function checkRef(ref: string): string {
  if (!REF_RE.test(ref) || ref.includes("..")) throw new ToolError("Invalid ref");
  return encodeURIComponent(ref);
}

export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

export async function gh(env: Env, pathAndQuery: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${API}${pathAndQuery}`, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "github-mcp-readonly",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new ToolError("Could not reach GitHub");
  }
  if (res.ok) return res.json();
  if (res.status === 404) throw new ToolError("Not found, or not accessible with the configured token");
  if (res.status === 401) throw new ToolError("GitHub rejected the configured token");
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const retry = res.headers.get("retry-after");
    if (res.headers.get("x-ratelimit-remaining") === "0" || retry || res.status === 429) {
      const when = retry
        ? `retry after ${retry}s`
        : reset
          ? `resets at ${new Date(reset * 1000).toISOString()}`
          : "try again later";
      throw new ToolError(`GitHub rate limit reached; ${when}`);
    }
    throw new ToolError("GitHub denied access (check token permissions)");
  }
  throw new ToolError(`GitHub error (HTTP ${res.status})`);
}
