#!/usr/bin/env node
import { getConfig } from "./config.js";
import { LocalCore } from "./core.js";
import { openUrl } from "./platform.js";
import { startOwnerServer } from "./server.js";

const cfg = getConfig();
const local = new LocalCore();
const handle = await startOwnerServer(local, {
  getCastDir: () => local.getActiveCastDir(),
  getRegistryError: () => local.getRegistryError(),
});
const url = `http://127.0.0.1:${cfg.port}`;
if (handle.role === "none") {
  console.error(`Port ${cfg.port} is used by another program. Set FLOW_MCP_PORT to a free port.`);
  process.exit(1);
}
if (handle.role === "owner") {
  const shutdown = () => {
    void Promise.allSettled([handle.close(), local.close()]).then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
console.log(handle.role === "owner" ? `Flow Studio running at ${url} (Ctrl+C to stop)` : `Flow Studio is already served by Claude's flow-mcp at ${url}`);
openUrl(url);
if (handle.role === "client") process.exit(0);
