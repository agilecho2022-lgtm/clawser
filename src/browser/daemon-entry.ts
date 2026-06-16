import { startBrowserControlServerFromConfig, stopBrowserControlServer } from "./server.js";

let stopping = false;

async function shutdown(signal: string) {
  if (stopping) {
    return;
  }
  stopping = true;
  await stopBrowserControlServer().catch(() => {});
  process.exit(signal === "SIGINT" ? 130 : 0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

const state = await startBrowserControlServerFromConfig();
if (!state) {
  process.exit(1);
}

await new Promise(() => {});
