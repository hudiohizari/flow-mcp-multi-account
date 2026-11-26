import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Browser, Page } from "playwright-core";
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
} from "../dist/chrome-process.js";
import { ChromeManager, getDefaultChromeManager, setDefaultChromeManager } from "../dist/chrome.js";
import { getConfig } from "../dist/config.js";

function makePage(opts: { url: string; lang?: string | string[] | Error; gotoRedirect?: string; throwWait?: boolean; throwFront?: boolean }) {
  let curUrl = opts.url;
  const calls = { goto: 0, bringToFront: 0 };
  const page = {
    url: () => curUrl,
    goto: async (next: string) => {
      calls.goto++;
      curUrl = opts.gotoRedirect ?? next;
    },
    bringToFront: async () => {
      calls.bringToFront++;
      if (opts.throwFront) throw new Error("no front");
    },
    evaluate: async (fn?: () => unknown) => {
      if (opts.lang instanceof Error) throw opts.lang;
      const val = Array.isArray(opts.lang) ? (opts.lang.shift() ?? "") : (opts.lang ?? "en");
      if (fn) {
        (globalThis as Record<string, unknown>).document = { documentElement: { lang: val } };
        try {
          return fn();
        } finally {
          delete (globalThis as Record<string, unknown>).document;
        }
      }
      return val;
    },
    waitForFunction: async (fn?: () => unknown) => {
      if (opts.throwWait) throw new Error("wait timeout");
      if (fn) {
        (globalThis as Record<string, unknown>).document = { documentElement: { lang: "en" } };
        try {
          return fn();
        } finally {
          delete (globalThis as Record<string, unknown>).document;
        }
      }
      return undefined;
    },
  } as unknown as Page;
  return { page, calls };
}

function makeBrowser(pages: Page[], opts: { noContext?: boolean; cdpFail?: boolean; sendFail?: boolean; closeFail?: boolean } = {}) {
  let connected = true;
  const listeners = new Map<string, (() => void)[]>();
  const browser = {
    isConnected: () => connected,
    contexts: () => (opts.noContext ? [] : [{
      pages: () => pages,
      newPage: async () => {
        const p = makePage({ url: "about:blank" });
        pages.push(p.page);
        return p.page;
      },
    }]),
    newBrowserCDPSession: async () => {
      if (opts.cdpFail) throw new Error("cdp fail");
      return {
        send: async () => {
          if (opts.sendFail) throw new Error("send fail");
        },
      };
    },
    close: async () => {
      connected = false;
      if (opts.closeFail) throw new Error("close fail");
    },
    on: (ev: string, cb: () => void) => {
      const list = listeners.get(ev) ?? [];
      list.push(cb);
      listeners.set(ev, list);
    },
  } as unknown as Browser;
  return {
    browser,
    disconnect: () => {
      connected = false;
      for (const cb of listeners.get("disconnected") ?? []) cb();
    },
  };
}

test("chrome-process URL helpers, process parser, probe, SingletonLock, and ensureEnglish", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-cp-"));
  try {
    const cfg = getConfig({
      FLOW_MCP_HOME: join(root, "home"),
      FLOW_MCP_FLOW_URL: "http://127.0.0.1:4100/flow/",
      FLOW_MCP_SIGNIN_URL: "http://127.0.0.1:4100/signin",
    });

    assert.equal(inEnglish("https://flow.google.com/"), "https://flow.google.com/?hl=en");
    assert.equal(isFlowHost("https://flow.google.com/project/1", cfg), true);
    assert.equal(isFlowHost("http://127.0.0.1:4100/flow/p", cfg), true);
    assert.equal(isFlowHost("http://127.0.0.1:4100/signin", cfg), false);
    assert.equal(isFlowHost("not-a-url", cfg), false);

    assert.equal(isSignInUrl("", cfg), false);
    assert.equal(isSignInUrl("https://accounts.google.com/v3/signin", cfg), true);
    assert.equal(isSignInUrl("https://flow.google.com/about/", cfg), true);
    assert.equal(isSignInUrl("http://127.0.0.1:4100/signin?next=1", cfg), true);
    assert.equal(isSignInUrl("not-a-url", cfg), false);
    assert.equal(isSignInUrl("https://example.com/", cfg), false);

    assert.equal(chromeExecutable({ ...cfg, chromeBin: root }, (p) => p === root), root);
    const prevLocalAppData = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = "C:\\Users\\demo\\AppData\\Local";
    try {
      assert.throws(() => chromeExecutable(cfg, () => false), /Google Chrome could not be found/);
    } finally {
      if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = prevLocalAppData;
    }

    assert.equal(extractUserDataDir('--user-data-dir="/tmp/my dir" --remote-debugging-port=9333'), "/tmp/my dir");
    assert.equal(extractUserDataDir("--user-data-dir='/tmp/s'"), "/tmp/s");
    assert.equal(extractUserDataDir("--user-data-dir=/tmp/plain --x"), "/tmp/plain");
    assert.equal(extractUserDataDir("--no-dir"), null);

    assert.equal(defaultIsPidAlive(process.pid), true);
    assert.equal(defaultIsPidAlive(999_999_999), false);

    const posixProcs = await defaultListProcesses("darwin");
    assert.ok(posixProcs.length > 0);
    const winProcs = await defaultListProcesses("win32", async () => ({ stdout: "101 chrome.exe\nbadline\n" }));
    assert.deepEqual(winProcs, [{ pid: 101, command: "chrome.exe" }]);
    const errProcs = await defaultListProcesses("darwin", async () => {
      throw new Error("ps fail");
    });
    assert.deepEqual(errProcs, []);

    // Probe HTTP test server
    let mode: "cdp" | "plain" | "badjson" | "500" = "cdp";
    const srv = createServer((_req, res) => {
      if (mode === "500") return void res.writeHead(500).end();
      if (mode === "badjson") return void res.writeHead(200).end("{bad");
      if (mode === "plain") return void res.writeHead(200).end(JSON.stringify({ ok: true }));
      res.writeHead(200).end(JSON.stringify({ Browser: "Chrome/130" }));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      assert.deepEqual(await defaultCdpProbe(base), { ok: true, isCdp: true });
      mode = "plain";
      assert.deepEqual(await defaultCdpProbe(base), { ok: true, isCdp: false });
      mode = "badjson";
      assert.deepEqual(await defaultCdpProbe(base), { ok: true, isCdp: false });
      mode = "500";
      assert.deepEqual(await defaultCdpProbe(base), { ok: false, isCdp: false });
      assert.deepEqual(await defaultCdpProbe("http://127.0.0.1:1"), { ok: false, isCdp: false });
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }

    // SingletonLock checks
    const prof = join(root, "prof");
    mkdirSync(prof, { recursive: true });
    inspectSingletonLock(prof, "myhost.local", () => false);
    const notDir = join(root, "regfile");
    writeFileSync(notDir, "x");
    assert.throws(() => inspectSingletonLock(notDir, "myhost", () => false));

    const lock = join(prof, "SingletonLock");
    writeFileSync(lock, "regular");
    inspectSingletonLock(prof, "myhost", () => false);
    rmSync(lock);

    symlinkSync("weirdtarget", lock);
    inspectSingletonLock(prof, "myhost", () => false);
    rmSync(lock);

    symlinkSync("otherhost-123", lock);
    assert.throws(() => inspectSingletonLock(prof, "myhost.local", () => false), /already open/);
    rmSync(lock);

    symlinkSync("myhost-555", lock);
    assert.throws(() => inspectSingletonLock(prof, "myhost.local", () => true), /already open/);
    writeFileSync(join(prof, "DevToolsActivePort"), "9333\n/devtools");
    inspectSingletonLock(prof, "myhost.local", () => false);

    // ensureEnglish
    await ensureEnglish(makePage({ url: "https://example.com/" }).page, cfg);
    await ensureEnglish(makePage({ url: "https://accounts.google.com/v3" }).page, cfg);
    await ensureEnglish(makePage({ url: "https://flow.google.com/", lang: new Error("eval") }).page, cfg);
    const esToEn = makePage({ url: "https://flow.google.com/", lang: ["es", "en"], throwWait: true });
    await ensureEnglish(esToEn.page, cfg);
    assert.equal(esToEn.calls.goto, 1);
    const stuckEs = makePage({ url: "https://flow.google.com/", lang: ["es", "es"] });
    await assert.rejects(() => ensureEnglish(stuckEs.page, cfg), /would not switch to English/);
    await ensureEnglish(makePage({ url: "https://flow.google.com/" }).page);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ChromeManager mutex, CDP verification, close escalation, switch, login, and passive probe", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-cm-"));
  try {
    const cfg = getConfig({
      FLOW_MCP_HOME: join(root, "home"),
      FLOW_MCP_CDP_PORT: "9445",
      FLOW_MCP_FLOW_URL: "https://flow.google.com/",
      FLOW_MCP_SIGNIN_URL: "https://accounts.google.com/",
    });
    const profA = join(root, "profA");
    const profB = join(root, "profB");
    mkdirSync(profA, { recursive: true });
    mkdirSync(profB, { recursive: true });

    // Default manager accessors + unreachable connect check
    const orig = getDefaultChromeManager();
    const custom = new ChromeManager();
    setDefaultChromeManager(custom);
    assert.equal(getDefaultChromeManager(), custom);
    setDefaultChromeManager(orig);

    let probeState: { ok: boolean; isCdp: boolean } = { ok: false, isCdp: false };
    let procList: { pid: number; command: string }[] = [];
    let alivePids = new Set<number>();
    const killed: [number, NodeJS.Signals][] = [];
    let currentBrowser = makeBrowser([]);

    const cm = new ChromeManager({
      getConfig: () => cfg,
      cdpProbe: async () => probeState,
      connectOverCDP: async () => currentBrowser.browser,
      spawnChrome: (_bin, args) => {
        const dirArg = args.find((a) => a.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
        probeState = { ok: true, isCdp: true };
        procList = [{ pid: 4001, command: `chrome --user-data-dir=${dirArg} --remote-debugging-port=9445` }];
        alivePids.add(4001);
        return 4001;
      },
      listProcesses: async () => procList,
      isPidAlive: (pid) => alivePids.has(pid),
      killPid: (pid, sig) => {
        killed.push([pid, sig]);
        if (sig === "SIGKILL") {
          alivePids.delete(pid);
          probeState = { ok: false, isCdp: false };
        }
      },
      executable: () => "/usr/bin/chrome",
      sleep: async () => undefined,
      launchTimeoutMs: 50,
      closeTimeoutMs: 20,
      termTimeoutMs: 20,
    });

    assert.equal(cm.switchInProgress, false);
    assert.deepEqual(await cm.verifyCdpOwner(profA), { up: false, pid: null });

    probeState = { ok: true, isCdp: false };
    await assert.rejects(() => cm.verifyCdpOwner(profA), /blocking Flow Studio/);

    probeState = { ok: true, isCdp: true };
    procList = [
      { pid: 99, command: "launchd" },
      { pid: 100, command: "chrome --remote-debugging-port=9445" },
      { pid: 200, command: `chrome --user-data-dir=${profB} --remote-debugging-port=9445` },
    ];
    await assert.rejects(() => cm.verifyCdpOwner(profA), /different browser profile/);

    // DevToolsActivePort fallback + trackedPid fallback + occupied fallback
    procList = [];
    writeFileSync(join(profA, "DevToolsActivePort"), "9445\n");
    assert.deepEqual(await cm.verifyCdpOwner(profA), { up: true, pid: null });
    rmSync(join(profA, "DevToolsActivePort"));
    await assert.rejects(() => cm.verifyCdpOwner(profA), /blocking Flow Studio/);

    // Probe passive states
    probeState = { ok: false, isCdp: false };
    assert.equal((await cm.probePassiveState(profA)).connected, false);

    probeState = { ok: true, isCdp: true };
    procList = [{ pid: 4001, command: `chrome --user-data-dir=${profA} --remote-debugging-port=9445` }];
    currentBrowser = makeBrowser([makePage({ url: "https://flow.google.com/project/11111111-1111-1111-1111-111111111111" }).page]);
    const pFlow = await cm.probePassiveState(profA);
    assert.equal(pFlow.signedIn, true);
    assert.equal(pFlow.inProject, true);
    assert.equal((await cm.probePassiveState(profA)).inProject, true);

    currentBrowser.disconnect();
    currentBrowser = makeBrowser([makePage({ url: "https://accounts.google.com/signin" }).page]);
    const pSign = await cm.probePassiveState(profA);
    assert.equal(pSign.authInProgress, true);

    currentBrowser.disconnect();
    currentBrowser = makeBrowser([makePage({ url: "https://example.com/" }).page]);
    const pBlank = await cm.probePassiveState(profA);
    assert.equal(pBlank.signedIn, false);
    assert.equal(pBlank.authInProgress, false);

    currentBrowser.disconnect();
    currentBrowser = makeBrowser([], { noContext: true });
    assert.equal((await cm.probePassiveState(profA)).url, "");

    procList = [{ pid: 200, command: `chrome --user-data-dir=${profB} --remote-debugging-port=9445` }];
    const pWrong = await cm.probePassiveState(profA);
    assert.equal(pWrong.connected, false);
    assert.ok(pWrong.hint);

    // Switch profile + closeChrome escalation SIGTERM -> SIGKILL
    procList = [{ pid: 4001, command: `chrome --user-data-dir=${profA} --remote-debugging-port=9445` }];
    alivePids = new Set([4001]);
    currentBrowser.disconnect();
    currentBrowser = makeBrowser([makePage({ url: "https://flow.google.com/" }).page], { sendFail: true, closeFail: true });
    await cm.getFlowPage(profA);
    const switched = await cm.switchProfile(profB);
    assert.equal(switched.authInProgress, false);
    assert.ok(killed.some(([, s]) => s === "SIGTERM"));
    assert.ok(killed.some(([, s]) => s === "SIGKILL"));

    // Connected cdpFail closeChrome
    probeState = { ok: false, isCdp: false };
    currentBrowser = makeBrowser([makePage({ url: "https://flow.google.com/" }).page], { cdpFail: true });
    probeState = { ok: true, isCdp: true };
    procList = [{ pid: 4001, command: `chrome --user-data-dir=${profB} --remote-debugging-port=9445` }];
    await cm.getFlowPage(profB);
    probeState = { ok: false, isCdp: false };
    alivePids.clear();
    await cm.closeChrome();

    // closeChrome when browser unconnected + cdpFail/closeFail & unconnected clean close
    await cm.closeChrome();
    probeState = { ok: true, isCdp: true };
    currentBrowser = makeBrowser([], { cdpFail: true, closeFail: true });
    await cm.closeChrome();
    probeState = { ok: true, isCdp: true };
    currentBrowser = makeBrowser([], { sendFail: true });
    const origClose = currentBrowser.browser.close;
    currentBrowser.browser.close = async () => {
      await origClose();
      probeState = { ok: false, isCdp: false };
      alivePids.clear();
    };
    await cm.closeChrome();

    // getFlowPage signIn redirect, blank->Flow page, noContext error & existing signIn tab
    currentBrowser = makeBrowser([], { noContext: true });
    await assert.rejects(() => cm.getFlowPage(profB), /no open browser window/);

    currentBrowser.disconnect();
    currentBrowser = makeBrowser([]);
    assert.equal((await cm.getFlowPage(profB)).authInProgress, false);

    currentBrowser.disconnect();
    currentBrowser = makeBrowser([makePage({ url: "https://accounts.google.com/" }).page]);
    assert.equal((await cm.getFlowPage(profB)).authInProgress, true);

    currentBrowser.disconnect();
    const pageHolder = makeBrowser([]);
    pageHolder.browser.contexts = () => [{
      pages: () => [],
      newPage: async () => makePage({ url: "about:blank", gotoRedirect: "https://accounts.google.com/v3" }).page,
    }] as unknown as ReturnType<Browser["contexts"]>;
    currentBrowser = pageHolder;
    assert.equal((await cm.getFlowPage(profB)).authInProgress, true);

    // Switch where SIGTERM kills cleanly without needing SIGKILL
    let termProfile = profA;
    const termCm = new ChromeManager({
      getConfig: () => cfg,
      cdpProbe: async () => ({ ok: probeState.ok, isCdp: probeState.isCdp }),
      connectOverCDP: async () => makeBrowser([makePage({ url: "https://flow.google.com/" }).page]).browser,
      spawnChrome: (_bin, args) => {
        termProfile = args.find((a) => a.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
        alivePids.add(4002);
        probeState = { ok: true, isCdp: true };
        return 4002;
      },
      listProcesses: async () => [{ pid: 4002, command: `chrome --user-data-dir=${termProfile} --remote-debugging-port=9445` }],
      isPidAlive: (p) => alivePids.has(p),
      killPid: (p, sig) => {
        if (sig === "SIGTERM") {
          alivePids.delete(p);
          probeState = { ok: false, isCdp: false };
        }
      },
      executable: () => "/usr/bin/chrome",
      sleep: async () => undefined,
      launchTimeoutMs: 20,
      closeTimeoutMs: 5,
      termTimeoutMs: 20,
    });
    probeState = { ok: true, isCdp: true };
    alivePids.add(4002);
    await termCm.switchProfile(profB);

    // Unconnected closeChrome when connectOverCDP returns null
    const nullConnCm = new ChromeManager({
      getConfig: () => cfg,
      cdpProbe: async () => ({ ok: true, isCdp: true }),
      connectOverCDP: async () => {
        throw new Error("gone");
      },
      isPidAlive: () => false,
      sleep: async () => undefined,
      closeTimeoutMs: 5,
    });
    await nullConnCm.closeChrome();

    // launchForLogin + disconnect callback + throwFront catch
    let disconnected = false;
    currentBrowser.disconnect();
    currentBrowser = makeBrowser([makePage({ url: "https://accounts.google.com/", throwFront: true }).page]);
    const loginOut = await cm.launchForLogin(profA, undefined, {
      switchFromOther: true,
      onDisconnect: () => {
        disconnected = true;
      },
    });
    assert.equal(loginOut.authInProgress, true);
    currentBrowser.disconnect();
    assert.equal(disconnected, true);

    // switchFromOther: false when already on same profile
    probeState = { ok: true, isCdp: true };
    procList = [{ pid: 4001, command: `chrome --user-data-dir=${profA} --remote-debugging-port=9445` }];
    currentBrowser = makeBrowser([makePage({ url: "https://flow.google.com/" }).page]);
    const loginSame = await cm.launchForLogin(profA, "https://flow.google.com/", { switchFromOther: false });
    assert.equal(loginSame.authInProgress, false);

    probeState = { ok: true, isCdp: false };
    await assert.rejects(() => cm.switchProfile(profB), /blocking Flow Studio/);
    await assert.rejects(() => cm.launchForLogin(profB, undefined, { switchFromOther: false }), /blocking Flow Studio/);

    // Launch timeout exercising sleep(250) loop
    const timeoutCm = new ChromeManager({
      getConfig: () => cfg,
      cdpProbe: async () => ({ ok: false, isCdp: false }),
      spawnChrome: () => undefined,
      executable: () => "/usr/bin/chrome",
      sleep: async () => {
        await new Promise((r) => setTimeout(r, 15));
      },
      launchTimeoutMs: 10,
    });
    await assert.rejects(() => timeoutCm.getFlowPage(profA), /could not connect/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ChromeManager trackedPid verify fallback and defaultDeps real spawn/kill smoke", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-cm-real-"));
  try {
    const cfg = getConfig({ FLOW_MCP_HOME: join(root, "home"), FLOW_MCP_CDP_PORT: "9446" });
    const prof = join(root, "prof");
    mkdirSync(prof, { recursive: true });
    let alive = true;
    const cm = new ChromeManager({
      getConfig: () => cfg,
      cdpProbe: async () => ({ ok: true, isCdp: true }),
      connectOverCDP: async () => makeBrowser([makePage({ url: "https://flow.google.com/" }).page]).browser,
      listProcesses: async () => [],
      spawnChrome: () => 5555,
      isPidAlive: () => alive,
      sleep: async () => undefined,
      executable: () => "/usr/bin/chrome",
      launchTimeoutMs: 50,
      closeTimeoutMs: 5,
      termTimeoutMs: 5,
    });
    await cm.switchProfile(prof);
    const verified = await cm.verifyCdpOwner(prof);
    assert.deepEqual(verified, { up: true, pid: 5555 });
    alive = false;

    // Real defaultDeps coverage: sleep, cdpProbe, connectOverCDP fail, spawnChrome + killPid on node child
    const defCm = new ChromeManager({
      getConfig: () => getConfig({ FLOW_MCP_HOME: join(root, "home2"), FLOW_MCP_CDP_PORT: "1" }),
      executable: () => process.execPath,
      launchTimeoutMs: 10,
      closeTimeoutMs: 10,
      termTimeoutMs: 10,
    });
    const spawnedPid = defCm["deps"].spawnChrome(process.execPath, ["-e", "setTimeout(() => {}, 5000)"])!;
    assert.equal(defCm["deps"].isPidAlive(spawnedPid), true);
    defCm["deps"].killPid(spawnedPid, "SIGKILL");
    await defCm["deps"].sleep(5);
    assert.deepEqual(await defCm["deps"].cdpProbe("http://127.0.0.1:1"), { ok: false, isCdp: false });
    await assert.rejects(() => defCm["deps"].connectOverCDP("http://127.0.0.1:1"));
    assert.ok(isFlowHost("https://flow.google.com/"));
    assert.equal(isSignInUrl("https://accounts.google.com/"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
