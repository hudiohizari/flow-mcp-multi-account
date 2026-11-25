import { execFile } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "playwright-core";
import { getConfig, type FlowConfig } from "./config.js";
import { AppError, ERROR_CODES } from "./errors.js";
import { t } from "./i18n.js";

const execFileAsync = promisify(execFile);

export function inEnglish(url: string): string {
  const u = new URL(url);
  u.searchParams.set("hl", "en");
  return u.toString();
}

export function isFlowHost(url: string, config: FlowConfig = getConfig()): boolean {
  if (/^https:\/\/(flow\.google\.com|labs\.google\/fx)/.test(url)) return true;
  try {
    const target = new URL(url);
    const custom = new URL(config.flowUrl);
    return target.origin === custom.origin && !isSignInUrl(url, config);
  } catch {
    return false;
  }
}

export function isSignInUrl(url: string, config: FlowConfig = getConfig()): boolean {
  if (!url) return false;
  if (/^https:\/\/accounts\.google\.com\//.test(url)) return true;
  try {
    const parsed = new URL(url);
    if (/\/about(\b|\/|\?|$)/.test(parsed.pathname) && /^https:\/\/(flow\.google\.com|labs\.google)/.test(url)) {
      return true;
    }
    if (config.signinUrl) {
      const custom = new URL(config.signinUrl);
      if (parsed.origin === custom.origin && parsed.pathname.startsWith(custom.pathname)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function chromeExecutable(
  config: FlowConfig = getConfig(),
  fileExists: (p: string) => boolean = existsSync,
): string {
  const candidates = [
    config.chromeBin,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : undefined,
  ].filter((p): p is string => Boolean(p));
  const found = candidates.find((p) => fileExists(p));
  if (!found) throw new AppError(503, ERROR_CODES.CHROME_NOT_FOUND, t("error.CHROME_NOT_FOUND"));
  return found;
}

export async function defaultCdpProbe(cdpUrl: string): Promise<{ ok: boolean; isCdp: boolean }> {
  try {
    const res = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { ok: false, isCdp: false };
    const data = (await res.json().catch(() => null)) as { Browser?: unknown; webSocketDebuggerUrl?: unknown } | null;
    const isCdp = Boolean(data && (typeof data.Browser === "string" || typeof data.webSocketDebuggerUrl === "string"));
    return { ok: true, isCdp };
  } catch {
    return { ok: false, isCdp: false };
  }
}

export function parseProcessLines(stdout: string): { pid: number; command: string }[] {
  const rows: { pid: number; command: string }[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+)\s+(.+)$/);
    if (m) rows.push({ pid: Number(m[1]), command: m[2] });
  }
  return rows;
}

export type ProcessExec = (
  file: string,
  args: string[],
  opts: { timeout: number; windowsHide?: boolean },
) => Promise<{ stdout: string }>;

export async function defaultListProcesses(
  platform: NodeJS.Platform,
  execFn: ProcessExec = execFileAsync,
): Promise<{ pid: number; command: string }[]> {
  try {
    if (platform === "win32") {
      const { stdout } = await execFn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }"],
        { timeout: 5000, windowsHide: true },
      );
      return parseProcessLines(stdout);
    }
    const { stdout } = await execFn("ps", ["-axo", "pid=,command="], { timeout: 5000 });
    return parseProcessLines(stdout);
  } catch {
    return [];
  }
}

export function extractUserDataDir(command: string): string | null {
  const quoted = command.match(/--user-data-dir="([^"]+)"/) ?? command.match(/--user-data-dir='([^']+)'/);
  if (quoted) return quoted[1];
  const plain = command.match(/--user-data-dir=(\S+)/);
  return plain ? plain[1] : null;
}

export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function inspectSingletonLock(
  profileDir: string,
  localHost: string,
  isPidAlive: (pid: number) => boolean,
): void {
  const lockPath = join(profileDir, "SingletonLock");
  let st;
  try {
    st = lstatSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (!st.isSymbolicLink()) return;
  const target = readlinkSync(lockPath);
  const match = target.match(/^(.+)-(\d+)$/);
  if (!match) return;
  const [, lockHost, pidStr] = match;
  const shortLocal = localHost.split(".")[0];
  const sameHost = lockHost === localHost || lockHost === shortLocal;
  if (!sameHost || isPidAlive(Number(pidStr))) {
    throw new AppError(503, ERROR_CODES.PROFILE_LOCKED, t("error.PROFILE_LOCKED"));
  }
  for (const stale of ["SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort"]) {
    rmSync(join(profileDir, stale), { force: true });
  }
}

export async function ensureEnglish(page: Page, config: FlowConfig = getConfig()): Promise<void> {
  if (!isFlowHost(page.url(), config) || isSignInUrl(page.url(), config)) return;
  const lang = () => page.evaluate(() => document.documentElement.lang).catch(() => "");
  const now = await lang();
  if (!now || /^en\b/i.test(now)) return;
  await page.goto(inEnglish(page.url()), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.documentElement.lang, null, { timeout: 15_000 }).catch(() => {});
  const after = await lang();
  if (after && !/^en\b/i.test(after)) {
    throw new AppError(
      400,
      ERROR_CODES.INVALID_STATE,
      `Flow is showing in "${after}" and would not switch to English. Add ?hl=en to Flow's address or set Google language to English.`,
    );
  }
}
