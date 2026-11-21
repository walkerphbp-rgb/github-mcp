import { createApp, loadEnv } from "./server";

let env;
try {
  env = loadEnv();
} catch (e) {
  console.error(`Startup refused: ${(e as Error).message}`);
  process.exit(1);
}

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";
const server = createApp(env);
server.listen(port, host, () => console.log(`github-mcp listening on ${host}:${port}`));

// Render sends SIGTERM on redeploy; PID 1 in a container needs an explicit handler.
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
