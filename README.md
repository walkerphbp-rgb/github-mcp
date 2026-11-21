# github-mcp (read-only, Render)

Stateless MCP server over Streamable HTTP. Six read-only tools over allowlisted repos:
`get_contents`, `search_code`, `list_issues`, `get_issue`, `list_pull_requests`, `get_pull_request`.

- `POST /mcp`: needs `Authorization: Bearer <MCP_AUTH_TOKEN>` (no/invalid token: 401; other methods: 405).
- `GET /health`: open liveness check, reveals nothing.
- The server refuses to start unless all three environment variables are set.

## Environment variables (set in Render, never in the repo)
| Name | Value |
|---|---|
| `MCP_AUTH_TOKEN` | random string, at least 24 characters (generate it yourself, e.g. a password manager's 64-character random) |
| `GITHUB_TOKEN` | fine-grained PAT: only the allowlisted repos; Contents: Read, Issues: Read, Pull requests: Read (Metadata: Read is automatic); expiry 90 days or less |
| `ALLOWED_REPOS` | comma-separated `owner/repo` list |

`PORT` is injected by Render.

## Deploy on Render (manual, free plan)
1. Put these files in a new GitHub repo (private is fine; no secrets are in it).
2. Render: New > Web Service > connect the repo > Language/Runtime **Docker** > Instance type **Free**.
3. Environment: add the three variables. **First test:** set `GITHUB_TOKEN` to any placeholder text, and replace it with the real PAT only after the connection works.
4. Advanced: Health Check Path `/health`. Create the service.

## Connect (Claude Android app, or web)
Connectors > + (Add custom connector):
- URL: `https://<your-service>.onrender.com/mcp`
- Authentication: **No sign-in**
- Request headers: name `authorization`, value `Bearer <MCP_AUTH_TOKEN>` (include the word Bearer and the space)

## Notes
- Free Render services sleep after about 15 idle minutes; the first call after a quiet spell can take up to a minute or fail once. Retry.
- Output is capped at 50 KB; files at 40 KB; issue/PR bodies at 10 KB; comments (max 20) at 1.5 KB. Truncation is flagged.
- GitHub content is untrusted data. No write tools, OAuth, or custom rate limiting. GitHub rate limits are surfaced as tool errors.

## Develop
`npm install`, `npm test` (62 mocked tests, no network), `npm run typecheck`, `npm run build && npm start` (needs the three variables).
`src/index.ts` is the request handler (Worker-style `fetch`); `src/server.ts` wraps it for Node; `src/main.ts` boots it.
