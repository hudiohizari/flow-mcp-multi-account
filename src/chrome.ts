import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { ensurePrivateDir } from "./account-paths.js";
import {
  chromeExecutable,
  defaultCdpProbe,
  defaultIsPidAlive,
  defaultListProcesses,
  ensureEnglish,
  extractUserDataDir,
  inEnglish,
  inspectSingletonLock,
  isFlowHost,
  isSignInUrl,
} from "./chrome-process.js";
import { getConfig, type FlowConfig } from "./config.js";
import { AppError, ERROR_CODES } from "./errors.js";
import { t } from "./i18n.js";

export { chromeExecutable, ensureEnglish, inEnglish, isFlowHost, isSignInUrl } from "./chrome-process.js";

export interface PassiveFlowProbe {
  connected: boolean;
  signedIn: boolean;
  inProject: boolean;
  authInProgress: boolean;
  url: string;
  hint?: string;
}

export interface ChromeDeps {
  getConfig: () => FlowConfig;
  cdpProbe: (cdpUrl: string) => Promise<{ ok: boolean; isCdp: boolean }>;
  connectOverCDP: (cdpUrl: string) => Promise<Browser>;
  spawnChrome: (bin: string, args: string[]) => number | undefined;
  listProcesses: (platform: NodeJS.Platform) => Promise<{ pid: number; command: string }[]>;
  isPidAlive: (pid: number) => boolean;
  killPid: (pid: number, signal: NodeJS.Signals) => void;
  executable: (config: FlowConfig) => string;
  sleep: (ms: number) => Promise<void>;
  getHostname: () => string;
  platform: NodeJS.Platform;
  launchTimeoutMs: number;
  closeTimeoutMs: number;
  termTimeoutMs: number;
}

function defaultDeps(): ChromeDeps {
  return {
    getConfig,
    cdpProbe: defaultCdpProbe,
    connectOverCDP: (url) => chromium.connectOverCDP(url),
    spawnChrome: (bin, args) => {
      const child = spawn(bin, args, { detached: true, stdio: "ignore" });
      child.unref();
      return child.pid;
    },
    listProcesses: defaultListProcesses,
    isPidAlive: defaultIsPidAlive,
    killPid: (pid, sig) => process.kill(pid, sig),
    executable: chromeExecutable,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    getHostname: hostname,
    platform: process.platform,
    launchTimeoutMs: 20_000,
    closeTimeoutMs: 8_000,
    termTimeoutMs: 2_000,
  };
}

export class ChromeManager {
  private deps: ChromeDeps;
  private browser: Browser | null = null;
  private trackedPid: number | null = null;
  private activeProfileDir: string | null = null;
  private abandonedProfileDir: string | null = null;
  private mutexTail: Promise<void> = Promise.resolve();
  private switching = false;
  private aborting = false;
  private disconnectHandler: (() => void) | null = null;

  constructor(overrides: Partial<ChromeDeps> = {}) {
    this.deps = { ...defaultDeps(), ...overrides };
  }

  get switchInProgress(): boolean {
    return this.switching;
  }

  setAbandonedProfileDir(profileDir: string | null): void {
    this.abandonedProfileDir = profileDir ? resolve(profileDir) : null;
  }

  abortPendingLaunches(): void {
    this.aborting = true;
  }

  async withMutex<T>(fn: () => Promise<T>, markSwitch = false): Promise<T> {
    const prev = this.mutexTail;
    let release!: () => void;
    this.mutexTail = new Promise<void>((r) => (release = r));
    await prev;
    if (markSwitch) this.switching = true;
    try {
      return await fn();
    } finally {
      if (markSwitch) this.switching = false;
      release();
    }
  }

  setDisconnectWatcher(cb: (() => void) | null): void {
    this.disconnectHandler = cb;
  }

  private bindDisconnect(b: Browser): void {
    b.on("disconnected", () => {
      if (this.browser === b) this.browser = null;
      const cb = this.disconnectHandler;
      this.disconnectHandler = null;
      if (cb) cb();
    });
  }

  checkSingletonLock(profileDir: string): void {
    inspectSingletonLock(profileDir, this.deps.getHostname(), this.deps.isPidAlive);
  }

  async verifyCdpOwner(expectedProfileDir: string, allowReclaim = false): Promise<{ up: boolean; pid: number | null }> {
    const cfg = this.deps.getConfig();
    const probe = await this.deps.cdpProbe(cfg.cdpUrl);
    if (!probe.ok) return { up: false, pid: null };
    if (!probe.isCdp) {
      throw new AppError(503, ERROR_CODES.CDP_PORT_OCCUPIED, t("error.CDP_PORT_OCCUPIED"));
    }

    const expectedResolved = resolve(expectedProfileDir);
    const procs = await this.deps.listProcesses(this.deps.platform);
    const portFlag = `--remote-debugging-port=${cfg.cdpPort}`;
    for (const proc of procs) {
      if (!proc.command.includes(portFlag)) continue;
      const dir = extractUserDataDir(proc.command);
      if (!dir) continue;
      if (resolve(dir) !== expectedResolved) {
        if (this.abandonedProfileDir && resolve(dir) === this.abandonedProfileDir) {
          if (!allowReclaim) return { up: false, pid: null };
          this.trackedPid = proc.pid;
          await this.closeChrome();
          this.abandonedProfileDir = null;
          return { up: false, pid: null };
        }
        throw new AppError(503, ERROR_CODES.CDP_WRONG_PROFILE, t("error.CDP_WRONG_PROFILE"));
      }
      this.trackedPid = proc.pid;
      return { up: true, pid: proc.pid };
    }

    const portFile = join(expectedResolved, "DevToolsActivePort");
    if (existsSync(portFile)) {
      const firstLine = readFileSync(portFile, "utf8").split(/\r?\n/)[0]?.trim();
      if (firstLine === String(cfg.cdpPort)) return { up: true, pid: this.trackedPid };
    }
    if (this.trackedPid && this.deps.isPidAlive(this.trackedPid)) {
      return { up: true, pid: this.trackedPid };
    }
    throw new AppError(503, ERROR_CODES.CDP_PORT_OCCUPIED, t("error.CDP_PORT_OCCUPIED"));
  }

  private async launchChrome(profileDir: string, startUrl?: string): Promise<void> {
    const cfg = this.deps.getConfig();
    const bin = this.deps.executable(cfg);
    ensurePrivateDir(profileDir);
    this.checkSingletonLock(profileDir);
    const pid = this.deps.spawnChrome(bin, [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${cfg.cdpPort}`,
      "--no-first-run",
      "--no-default-browser-check",
      inEnglish(startUrl || cfg.flowUrl),
    ]);
    if (pid) this.trackedPid = pid;
    const deadline = Date.now() + this.deps.launchTimeoutMs;
    while (Date.now() < deadline) {
      if (this.aborting) throw new AppError(503, ERROR_CODES.CDP_UNAVAILABLE, t("error.CHROME_START_FAILED"));
      const probe = await this.deps.cdpProbe(cfg.cdpUrl);
      if (probe.ok && probe.isCdp) {
        this.activeProfileDir = resolve(profileDir);
        return;
      }
      await this.deps.sleep(250);
    }
    throw new AppError(503, ERROR_CODES.CDP_UNAVAILABLE, t("error.CHROME_START_FAILED"));
  }

  async closeChromeSerialized(): Promise<void> {
    this.aborting = true;
    try {
      await this.withMutex(() => this.closeChrome());
    } finally {
      this.aborting = false;
    }
  }

  async closeChrome(): Promise<void> {
    const cfg = this.deps.getConfig();
    this.disconnectHandler = null;
    if (this.browser?.isConnected()) {
      const cdp = await this.browser.newBrowserCDPSession().catch(() => null);
      if (cdp) await cdp.send("Browser.close").catch(() => {});
      await this.browser.close().catch(() => {});
      this.browser = null;
    } else if ((await this.deps.cdpProbe(cfg.cdpUrl)).ok) {
      const b = await this.deps.connectOverCDP(cfg.cdpUrl).catch(() => null);
      if (b) {
        const cdp = await b.newBrowserCDPSession().catch(() => null);
        if (cdp) await cdp.send("Browser.close").catch(() => {});
        await b.close().catch(() => {});
      }
    }

    const closeDeadline = Date.now() + this.deps.closeTimeoutMs;
    while (Date.now() < closeDeadline) {
      const probe = await this.deps.cdpProbe(cfg.cdpUrl);
      const alive = this.trackedPid ? this.deps.isPidAlive(this.trackedPid) : false;
      if (!probe.ok && !alive) {
        this.trackedPid = null;
        this.activeProfileDir = null;
        return;
      }
      await this.deps.sleep(200);
    }

    if (this.trackedPid && this.deps.isPidAlive(this.trackedPid)) {
      this.deps.killPid(this.trackedPid, "SIGTERM");
      const termDeadline = Date.now() + this.deps.termTimeoutMs;
      while (Date.now() < termDeadline && this.deps.isPidAlive(this.trackedPid)) {
        await this.deps.sleep(150);
      }
      if (this.deps.isPidAlive(this.trackedPid)) {
        this.deps.killPid(this.trackedPid, "SIGKILL");
      }
    }
    this.trackedPid = null;
    this.activeProfileDir = null;
  }

  private async connectUnlocked(profileDir: string, startUrl?: string): Promise<Browser> {
    const cfg = this.deps.getConfig();
    const resolved = resolve(profileDir);
    if (this.browser?.isConnected() && this.activeProfileDir === resolved) return this.browser;
    const owner = await this.verifyCdpOwner(profileDir, true);
    if (!owner.up) await this.launchChrome(profileDir, startUrl);
    const connected = await this.deps.connectOverCDP(cfg.cdpUrl);
    this.browser = connected;
    this.activeProfileDir = resolved;
    this.bindDisconnect(connected);
    return connected;
  }

  private async openOrReuseFlowPage(b: Browser, startUrl?: string): Promise<{ page: Page; authInProgress: boolean }> {
    const cfg = this.deps.getConfig();
    const context = b.contexts()[0];
    if (!context) throw new AppError(503, ERROR_CODES.CDP_UNAVAILABLE, t("error.CHROME_NO_CONTEXT"));
    const pages = context.pages();
    const flowPage = pages.find((p) => isFlowHost(p.url(), cfg) && !isSignInUrl(p.url(), cfg));
    if (flowPage) {
      await ensureEnglish(flowPage, cfg);
      return { page: flowPage, authInProgress: false };
    }
    const signInPage = pages.find((p) => isSignInUrl(p.url(), cfg));
    if (signInPage) return { page: signInPage, authInProgress: true };
    const page = await context.newPage();
    await page.goto(inEnglish(startUrl || cfg.flowUrl), { waitUntil: "domcontentloaded" });
    if (isSignInUrl(page.url(), cfg)) return { page, authInProgress: true };
    await ensureEnglish(page, cfg);
    return { page, authInProgress: false };
  }

  async getFlowPage(profileDir: string, startUrl?: string): Promise<{ page: Page; authInProgress: boolean }> {
    const b = await this.withMutex(() => this.connectUnlocked(profileDir, startUrl));
    return this.openOrReuseFlowPage(b, startUrl);
  }

  async switchProfile(targetProfileDir: string, startUrl?: string): Promise<{ page: Page; authInProgress: boolean }> {
    return this.withMutex(async () => {
      const cfg = this.deps.getConfig();
      const probe = await this.deps.cdpProbe(cfg.cdpUrl);
      if (probe.ok) {
        if (!probe.isCdp) throw new AppError(503, ERROR_CODES.CDP_PORT_OCCUPIED, t("error.CDP_PORT_OCCUPIED"));
        await this.closeChrome();
        this.abandonedProfileDir = null;
      }
      await this.launchChrome(targetProfileDir, startUrl);
      const b = await this.connectUnlocked(targetProfileDir, startUrl);
      return this.openOrReuseFlowPage(b, startUrl);
    }, true);
  }

  async launchForLogin(
    targetProfileDir: string,
    startUrl: string | undefined,
    opts: { switchFromOther: boolean; onDisconnect?: () => void },
  ): Promise<{ page: Page; url: string; authInProgress: boolean }> {
    return this.withMutex(async () => {
      const cfg = this.deps.getConfig();
      const probe = await this.deps.cdpProbe(cfg.cdpUrl);
      if (probe.ok) {
        if (!probe.isCdp) throw new AppError(503, ERROR_CODES.CDP_PORT_OCCUPIED, t("error.CDP_PORT_OCCUPIED"));
        if (opts.switchFromOther) {
          await this.closeChrome();
          this.abandonedProfileDir = null;
        }
      }
      const b = await this.connectUnlocked(targetProfileDir, startUrl);
      const res = await this.openOrReuseFlowPage(b, startUrl);
      await res.page.bringToFront().catch(() => {});
      if (opts.onDisconnect) this.setDisconnectWatcher(opts.onDisconnect);
      return { page: res.page, url: res.page.url(), authInProgress: res.authInProgress };
    }, opts.switchFromOther);
  }

  async probePassiveState(profileDir: string): Promise<PassiveFlowProbe> {
    const cfg = this.deps.getConfig();
    try {
      const owner = await this.verifyCdpOwner(profileDir);
      if (!owner.up) return { connected: false, signedIn: false, inProject: false, authInProgress: false, url: "" };
      const resolved = resolve(profileDir);
      const b = this.browser?.isConnected() && this.activeProfileDir === resolved
        ? this.browser
        : await this.deps.connectOverCDP(cfg.cdpUrl);
      if (this.browser !== b) {
        this.browser = b;
        this.activeProfileDir = resolved;
        this.bindDisconnect(b);
      }
      const context = b.contexts()[0];
      const pages = context ? context.pages() : [];
      const flowPage = pages.find((p) => isFlowHost(p.url(), cfg) && !isSignInUrl(p.url(), cfg));
      if (flowPage) {
        const url = flowPage.url();
        return { connected: true, signedIn: true, inProject: /\/project\//.test(url), authInProgress: false, url };
      }
      const signInPage = pages.find((p) => isSignInUrl(p.url(), cfg));
      if (signInPage) {
        return { connected: true, signedIn: false, inProject: false, authInProgress: true, url: signInPage.url(), hint: t("hint.authInProgress") };
      }
      return { connected: true, signedIn: false, inProject: false, authInProgress: false, url: pages[0]?.url() ?? "", hint: t("hint.signIn") };
    } catch (err) {
      return { connected: false, signedIn: false, inProject: false, authInProgress: false, url: "", hint: err instanceof Error ? err.message : String(err) };
    }
  }
}

let defaultChrome = new ChromeManager();

export function setDefaultChromeManager(manager: ChromeManager): void {
  defaultChrome = manager;
}

export function getDefaultChromeManager(): ChromeManager {
  return defaultChrome;
}
