import { existsSync } from "node:fs";
import { resolveAccountPaths } from "./account-paths.js";
import { AccountStore, type AccountView } from "./accounts.js";
import { ChromeManager } from "./chrome.js";
import { getConfig, type FlowConfig } from "./config.js";
import { AppError, ERROR_CODES } from "./errors.js";
import { t } from "./i18n.js";
import { RemoteCore } from "./remote.js";
import { normalizeAccountLabel } from "./shared/account-validation.js";
import { STATIC_ROUTES } from "./shared/routes.js";

export interface ParsedLoginArgs {
  label?: string;
  create: boolean;
}

export interface LoginCliDeps {
  getConfig: () => FlowConfig;
  probeHealth: (port: number) => Promise<"owner" | "other" | "free">;
  createRemote: (getCfg: () => FlowConfig) => Pick<RemoteCore, "accounts" | "account_add" | "account_login">;
  createStandalone: (cfg: FlowConfig) => { store: AccountStore; chrome: ChromeManager };
  log: (msg: string) => void;
}

export function parseLoginArgs(argv: string[]): ParsedLoginArgs {
  let create = false;
  let label: string | undefined;
  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg === "--create") {
      create = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, `Unknown option "${arg}". Usage: npm run login [-- <label>] [--create]`);
    }
    if (label !== undefined) {
      throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, "Pass a single account label. Usage: npm run login [-- <label>] [--create]");
    }
    label = arg;
  }
  if (create && !label) {
    throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, "Pass an account label when using --create.");
  }
  return { label, create };
}

async function defaultProbeHealth(port: number): Promise<"owner" | "other" | "free"> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${STATIC_ROUTES.HEALTH}`, { signal: AbortSignal.timeout(2000) });
    const body = (await res.json().catch(() => null)) as { name?: string } | null;
    if (body?.name === "flow-mcp") return "owner";
    return "other";
  } catch {
    return "free";
  }
}

function defaultDeps(): LoginCliDeps {
  return {
    getConfig,
    probeHealth: defaultProbeHealth,
    createRemote: (getCfg) => new RemoteCore(getCfg),
    createStandalone: (cfg) => ({ store: new AccountStore(cfg), chrome: new ChromeManager({ getConfig: () => cfg }) }),
    log: (msg) => console.log(msg),
  };
}

function logLaunchSummary(
  log: (msg: string) => void,
  url: string,
  account: Pick<AccountView, "id" | "label">,
  profileDir: string,
): void {
  log(`Chrome is open on ${url}`);
  log(`Account: ${account.label} (${account.id})`);
  log(`Profile: ${profileDir}`);
  log("Sign in to Google in that window, then open or create a Flow project.");
}

export async function runLoginCli(argv: string[], overrides: Partial<LoginCliDeps> = {}): Promise<void> {
  const deps = { ...defaultDeps(), ...overrides };
  const parsed = parseLoginArgs(argv);
  const cfg = deps.getConfig();
  const health = await deps.probeHealth(cfg.port);

  if (health === "other") {
    throw new AppError(409, ERROR_CODES.CDP_PORT_OCCUPIED, `Port ${cfg.port} is used by another program. Set FLOW_MCP_PORT to a free port.`);
  }

  if (health === "owner" && existsSync(cfg.tokenFile)) {
    const remote = deps.createRemote(() => cfg);
    if (!parsed.label) {
      const out = (await remote.account_login({})) as { account: AccountView; url: string; profileDir: string };
      logLaunchSummary(deps.log, out.url, out.account, out.profileDir);
      return;
    }
    const listOut = (await remote.accounts()) as { accounts: AccountView[] };
    const needle = normalizeAccountLabel(parsed.label).toLowerCase();
    let target = listOut.accounts.find((a) => normalizeAccountLabel(a.label).toLowerCase() === needle);
    if (!target) {
      if (!parsed.create) {
        throw new AppError(404, ERROR_CODES.ACCOUNT_NOT_FOUND, `Account "${parsed.label}" not found. Pass --create to add it.`);
      }
      const added = (await remote.account_add({ label: parsed.label })) as { account: AccountView };
      target = added.account;
    }
    const out = (await remote.account_login({ id: target.id })) as { account: AccountView; url: string; profileDir: string };
    logLaunchSummary(deps.log, out.url, out.account, out.profileDir);
    return;
  }

  const { store, chrome } = deps.createStandalone(cfg);
  store.assertHealthy();
  let target = store.requireActiveAccount();
  if (parsed.label) {
    const needle = normalizeAccountLabel(parsed.label).toLowerCase();
    const existing = store.listAccounts().find((a) => normalizeAccountLabel(a.label).toLowerCase() === needle);
    if (existing) {
      target = existing;
    } else if (parsed.create) {
      target = store.addAccount(parsed.label);
    } else {
      throw new AppError(404, ERROR_CODES.ACCOUNT_NOT_FOUND, `Account "${parsed.label}" not found. Pass --create to add it.`);
    }
  }
  if (!target.enabled) {
    throw new AppError(409, ERROR_CODES.ACCOUNT_DISABLED, t("error.ACCOUNT_DISABLED", { label: target.label }));
  }

  const active = store.requireActiveAccount();
  const switchFromOther = target.id !== active.id;
  const targetPaths = resolveAccountPaths(target, cfg);
  const launched = await chrome.launchForLogin(targetPaths.profileDir, target.lastProjectUrl, {
    switchFromOther,
  });
  if (switchFromOther) store.setActive(target.id, null);
  logLaunchSummary(deps.log, launched.url, target, targetPaths.profileDir);
}
