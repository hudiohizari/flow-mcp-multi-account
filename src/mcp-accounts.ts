import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Core } from "./core.js";
import type { ToolResult } from "./mcp-patience.js";
import { shapes } from "./schemas.js";

export interface McpHelpers {
  reply: (work: Promise<unknown>, extra?: object) => Promise<ToolResult>;
  patient: (tool: string, work: Promise<unknown>) => Promise<unknown>;
}

export function registerAccountTools(server: McpServer, core: Core, { reply, patient }: McpHelpers): void {
  server.registerTool(
    "flow_accounts",
    {
      title: "List Flow accounts",
      description: "List all registered Google Flow accounts, priority order, active selection, and persisted plan/credits without launching Chrome.",
      inputSchema: shapes.accounts,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => reply(core.accounts()),
  );

  server.registerTool(
    "flow_account_add",
    {
      title: "Add a Flow account",
      description: "Register a new isolated Google Flow account profile with a unique label (1-60 chars). Run flow_account_login afterwards to sign in.",
      inputSchema: shapes.account_add,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) => reply(core.account_add(args)),
  );

  server.registerTool(
    "flow_account_switch",
    {
      title: "Switch active Flow account",
      description: "Switch the single Flow Chrome window cleanly to another enabled account profile when no generation or Chrome action is running.",
      inputSchema: shapes.account_switch,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) => reply(patient("flow_account_switch", core.account_switch(args))),
  );

  server.registerTool(
    "flow_account_login",
    {
      title: "Open Flow Chrome to sign in",
      description: "Open or focus Flow Chrome on the active (or specified) account so the user can sign in to Google manually.",
      inputSchema: shapes.account_login,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) => reply(patient("flow_account_login", core.account_login(args))),
  );

  server.registerTool(
    "flow_account_rename",
    {
      title: "Rename a Flow account",
      description: "Change the display label of a registered Flow account while keeping its isolated profile directory unchanged.",
      inputSchema: shapes.account_rename,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => reply(core.account_rename(args)),
  );

  server.registerTool(
    "flow_account_enable",
    {
      title: "Enable or disable a Flow account",
      description: "Enable or disable an inactive account. Cannot disable the active account or the sole enabled account.",
      inputSchema: shapes.account_enable,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => reply(core.account_enable(args)),
  );

  server.registerTool(
    "flow_account_reorder",
    {
      title: "Reorder Flow account priority",
      description: "Set the exact priority order across all registered account IDs (highest priority first).",
      inputSchema: shapes.account_reorder,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => reply(core.account_reorder(args)),
  );

  server.registerTool(
    "flow_account_remove",
    {
      title: "Remove an inactive Flow account",
      description: "Remove an inactive non-default account from the registry and move its isolated profile folder to the OS Trash without touching saved films.",
      inputSchema: shapes.account_remove,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args) => reply(core.account_remove(args)),
  );

  server.registerTool(
    "flow_account_refresh",
    {
      title: "Refresh active Flow account balance",
      description: "Read live plan and credits remaining from the active Flow account when an open Flow project is idle.",
      inputSchema: shapes.account_refresh,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    (args) => reply(patient("flow_account_refresh", core.account_refresh(args))),
  );

  server.registerTool(
    "flow_account_config",
    {
      title: "Configure automatic credit failover",
      description: "Read or update automatic credit failover across enabled Google Flow accounts.",
      inputSchema: shapes.account_config,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (args) => reply(core.account_config(args)),
  );
}
