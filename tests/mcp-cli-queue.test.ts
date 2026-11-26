import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AccountService } from "../dist/account-service.js";
import { AccountStore } from "../dist/accounts.js";
import { ChromeManager } from "../dist/chrome.js";
import { getConfig } from "../dist/config.js";
import type { Core } from "../dist/core.js";
import { AppError, ERROR_CODES } from "../dist/errors.js";
import { parseLoginArgs, runLoginCli } from "../dist/login-cli.js";
import { registerAccountTools } from "../dist/mcp-accounts.js";
import { createPatienceRunner } from "../dist/mcp-patience.js";
import { JobQueue } from "../dist/queue.js";

test("JobQueue handles pacing cancellation, retryable errors, and active state", async () => {
  let count = 0;
  const q = new JobQueue(
    async (job) => {
      count++;
      if (count === 1) return ["ok.mp4"];
      if (job.params.prompt === "agent-drop") throw new Error("agent finished without creating anything");
      if (job.params.prompt === "throw-str") throw "string-failure";
      return [`done-${count}.mp4`];
    },
    () => ({ minMs: 120, maxMs: 120 }),
  );
  // Also construct with default delay provider and trigger delay callback across 2 jobs
  const prevMin = process.env.FLOW_MCP_PAUSE_MIN_S;
  const prevMax = process.env.FLOW_MCP_PAUSE_MAX_S;
  process.env.FLOW_MCP_PAUSE_MIN_S = "0.005";
  process.env.FLOW_MCP_PAUSE_MAX_S = "0.005";
  try {
    const qDefault = new JobQueue(async () => ["a"]);
    assert.equal(qDefault.active, false);
    qDefault.add({ prompt: "x", type: "image", max_credits: 0, output_dir: "/tmp", file_stem: "s" });
    qDefault.add({ prompt: "y", type: "image", max_credits: 0, output_dir: "/tmp", file_stem: "s2" });
    await new Promise((r) => setTimeout(r, 40));
  } finally {
    if (prevMin === undefined) delete process.env.FLOW_MCP_PAUSE_MIN_S;
    else process.env.FLOW_MCP_PAUSE_MIN_S = prevMin;
    if (prevMax === undefined) delete process.env.FLOW_MCP_PAUSE_MAX_S;
    else process.env.FLOW_MCP_PAUSE_MAX_S = prevMax;
  }

  const j1 = q.add({ prompt: "first", type: "image", max_credits: 0, output_dir: "/tmp", file_stem: "s1" }, { accountId: "a1", accountLabel: "A" });
  assert.equal(q.busy, true);
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(j1.status, "done");

  // Add j2 while pacing sleeps 40ms, then cancel j2 mid-pacing
  const j2 = q.add({ prompt: "cancelled-during-pace", type: "image", max_credits: 0, output_dir: "/tmp", file_stem: "s2" });
  const j3 = q.add({ prompt: "agent-drop", type: "image", max_credits: 0, output_dir: "/tmp", file_stem: "s3", retries: 0 });
  const j4 = q.add({ prompt: "throw-str", type: "image", max_credits: 0, output_dir: "/tmp", file_stem: "s4" });
  await new Promise((r) => setTimeout(r, 10));
  q.cancel(j2.id);
  assert.equal(j2.status, "cancelled");
  assert.equal(q.cancel("missing"), undefined);
  await new Promise((r) => setTimeout(r, 320));
  assert.equal(j2.status, "cancelled");
  assert.equal(j3.status, "failed");
  assert.equal(j4.status, "failed");

  // Auto-retry when retries: 1
  const qRetry = new JobQueue(
    async () => {
      throw new Error("agent finished without creating");
    },
    () => ({ minMs: 0, maxMs: 0 }),
  );
  const jr = qRetry.add({ prompt: "auto", type: "image", max_credits: 0, output_dir: "/tmp", file_stem: "s5" });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(jr.status, "failed");
  assert.equal(jr.attempts, 2);
  const retriedJob = qRetry.retry(jr.id);
  assert.ok(retriedJob && (retriedJob.status === "queued" || retriedJob.status === "running"));
  assert.equal(qRetry.retry("none"), undefined);
  await new Promise((r) => setTimeout(r, 40));

  // Pacing sleep keeps queue.active === true and rejects CHROME_BUSY even with 0 running jobs
  const pacingRoot = mkdtempSync(join(tmpdir(), "flow-q-pace-"));
  try {
    const qPace = new JobQueue(async () => ["ok.mp4"], () => ({ minMs: 150, maxMs: 150 }));
    const pCfg = getConfig({ FLOW_MCP_HOME: join(pacingRoot, "home"), FLOW_MCP_OUTPUT: join(pacingRoot, "out") });
    const pSvc = new AccountService({
      store: new AccountStore(pCfg),
      chrome: new ChromeManager({ getConfig: () => pCfg }),
      queue: qPace,
      getConfig: () => pCfg,
      flow: {
        getFlowState: async () => ({ url: "", connected: false, signedIn: false, inProject: false }),
        createProject: async () => ({ id: "1", url: "", title: "" }),
        listCharacters: async () => [],
      },
    });
    const pj1 = qPace.add({ prompt: "p1", type: "image", max_credits: 0, output_dir: pacingRoot, file_stem: "p1" });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(pj1.status, "done");
    const pj2 = qPace.add({ prompt: "p2", type: "image", max_credits: 0, output_dir: pacingRoot, file_stem: "p2" });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(pj2.status, "queued");
    assert.equal(qPace.list().some((j) => j.status === "running"), false);
    assert.ok(qPace.pausedReason);
    assert.equal(qPace.active, true);
    assert.throws(() => pSvc.assertIdleForSwitch(), (e: AppError) => e.status === 409 && e.code === ERROR_CODES.CHROME_BUSY);
    await assert.rejects(() => pSvc.wrapChromeOp(async () => "x"), (e: AppError) => e.status === 409 && e.code === ERROR_CODES.CHROME_BUSY);
    await new Promise((r) => setTimeout(r, 170));
  } finally {
    rmSync(pacingRoot, { recursive: true, force: true });
  }
});

test("mcp-patience and mcp-accounts handle slow tasks, errors, waitFor, and all 9 MCP tools", async () => {
  let waitCount = 0;
  const runner = createPatienceRunner(
    {
      wait: async ({ job_ids }) => {
        waitCount++;
        return { finished: waitCount >= 1, job_ids };
      },
    },
    15,
  );

  // reply formats objects, arrays, AppError with/without meta, Error, and non-Error
  const rObj = await runner.reply(Promise.resolve({ ok: true }), { extra: 1 });
  assert.equal(JSON.parse(rObj.content[0].text).extra, 1);
  const rArr = await runner.reply(Promise.resolve([1, 2]));
  assert.deepEqual(JSON.parse(rArr.content[0].text), [1, 2]);
  const rApp = await runner.reply(Promise.reject(new AppError(409, ERROR_CODES.CHROME_BUSY, "busy", { who: "a" })));
  assert.equal(rApp.isError, true);
  assert.equal(JSON.parse(rApp.content[0].text).meta.who, "a");
  const rAppNoMeta = await runner.reply(Promise.reject(new AppError(404, ERROR_CODES.NOT_FOUND, "missing")));
  assert.equal(JSON.parse(rAppNoMeta.content[0].text).code, "NOT_FOUND");
  const rErr = await runner.reply(Promise.reject(new Error("boom")));
  assert.equal(JSON.parse(rErr.content[0].text).error, "boom");
  const rStr = await runner.reply(Promise.reject("str-err"));
  assert.equal(JSON.parse(rStr.content[0].text).error, "str-err");

  // patient fast + slow success + slow failure
  assert.deepEqual(await runner.patient("fast", Promise.resolve({ done: 1 })), { done: 1 });
  const slowOk = (await runner.patient(
    "slow_ok",
    new Promise((r) => setTimeout(() => r({ ok: true }), 40)),
  )) as { still_working: boolean; task_id: string };
  assert.equal(slowOk.still_working, true);
  assert.equal(runner.hasSlowCalls(), true);
  assert.equal(runner.slowCalls().length, 1);

  const waitedOk = (await runner.waitFor({ job_ids: [slowOk.task_id], timeout_seconds: 2 })) as { finished: boolean; tasks: { status: string }[] };
  assert.equal(waitedOk.finished, true);
  assert.equal(waitedOk.tasks[0].status, "done");

  const slowFail = (await runner.patient(
    "slow_fail",
    new Promise((_, fail) => setTimeout(() => fail(new Error("slow-err")), 25)),
  )) as { task_id: string };
  const slowFailStr = (await runner.patient(
    "slow_str",
    new Promise((_, fail) => setTimeout(() => fail("slow-str"), 25)),
  )) as { task_id: string };
  await new Promise((r) => setTimeout(r, 50));
  const waitedFail = (await runner.waitFor({ job_ids: [slowFail.task_id, slowFailStr.task_id, "task-unknown", "j1"], timeout_seconds: 10 })) as { finished: boolean; tasks: { status: string }[] };
  assert.equal(waitedFail.tasks[2].status, "unknown");

  const waitDefault = (await runner.waitFor({ timeout_seconds: 5 })) as { finished: boolean };
  assert.equal(waitDefault.finished, true);

  // Register and invoke all 9 MCP account tools
  const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
  const fakeMcp = {
    registerTool: (name: string, _def: unknown, handler: (args: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;

  const coreStub = {
    accounts: async () => ({ accounts: [] }),
    account_add: async (a: unknown) => a,
    account_switch: async (a: unknown) => a,
    account_login: async (a: unknown) => a,
    account_rename: async (a: unknown) => a,
    account_enable: async (a: unknown) => a,
    account_reorder: async (a: unknown) => a,
    account_remove: async (a: unknown) => a,
    account_refresh: async (a: unknown) => a,
    account_config: async (a: unknown) => a,
  } as unknown as Core;

  registerAccountTools(fakeMcp, coreStub, { reply: runner.reply, patient: runner.patient });
  assert.equal(handlers.size, 10);
  for (const [name, fn] of handlers) {
    const res = (await fn({ label: "X", ids: ["a"], enabled: true })) as { content: { text: string }[] };
    assert.ok(res.content[0].text.length > 0, `handler ${name} returned content`);
  }
});

test("login-cli parses args, delegates to running owner, and executes standalone flows", async () => {
  assert.deepEqual(parseLoginArgs([]), { label: undefined, create: false });
  assert.deepEqual(parseLoginArgs(["--", "Backup 1", "--create"]), { label: "Backup 1", create: true });
  assert.throws(() => parseLoginArgs(["--bad"]), /Unknown option/);
  assert.throws(() => parseLoginArgs(["One", "Two"]), /single account label/);
  assert.throws(() => parseLoginArgs(["--create"]), /when using --create/);

  const root = mkdtempSync(join(tmpdir(), "flow-cli-"));
  try {
    const cfg = getConfig({ FLOW_MCP_HOME: join(root, "home"), FLOW_MCP_OUTPUT: join(root, "out"), FLOW_MCP_PORT: "9449" });
    mkdirSync(cfg.homeDir, { recursive: true });
    const logs: string[] = [];

    // Port occupied by other program -> throws
    await assert.rejects(
      () => runLoginCli([], { getConfig: () => cfg, probeHealth: async () => "other", log: (m) => logs.push(m) }),
      /used by another program/,
    );

    // Owner running delegation (no arg, existing label, missing without --create, missing with --create)
    writeFileSync(cfg.tokenFile, "tok");
    const remoteState = {
      accounts: [{ id: "default", slug: "default", label: "Primary", active: true, isDefault: true, enabled: true, priority: 1, needsRelogin: false, createdAt: "", updatedAt: "" }],
    };
    const remoteStub = {
      accounts: async () => remoteState,
      account_add: async ({ label }: { label: string }) => {
        const acc = { id: "b1", slug: "b1", label, active: false, isDefault: false, enabled: true, priority: 2, needsRelogin: true, createdAt: "", updatedAt: "" };
        remoteState.accounts.push(acc);
        return { account: acc };
      },
      account_login: async ({ id }: { id?: string }) => ({
        account: remoteState.accounts.find((a) => a.id === (id ?? "default"))!,
        url: "https://flow.google.com/",
        profileDir: join(cfg.homeDir, "chrome-profile"),
      }),
    };

    await runLoginCli([], { getConfig: () => cfg, probeHealth: async () => "owner", createRemote: () => remoteStub, log: (m) => logs.push(m) });
    await runLoginCli(["Primary"], { getConfig: () => cfg, probeHealth: async () => "owner", createRemote: () => remoteStub, log: (m) => logs.push(m) });
    await assert.rejects(
      () => runLoginCli(["Missing"], { getConfig: () => cfg, probeHealth: async () => "owner", createRemote: () => remoteStub, log: (m) => logs.push(m) }),
      /Pass --create/,
    );
    await runLoginCli(["Backup 1", "--create"], {
      getConfig: () => cfg,
      probeHealth: async () => "owner",
      createRemote: () => remoteStub,
      log: (m) => logs.push(m),
    });
    assert.ok(logs.some((l) => l.includes("Backup 1")));

    // Standalone mode (no owner running)
    const standaloneCfg = getConfig({ FLOW_MCP_HOME: join(root, "standalone"), FLOW_MCP_OUTPUT: join(root, "sout"), FLOW_MCP_PORT: "9450" });
    const fakeChrome = {
      launchForLogin: async (profileDir: string) => ({ page: {} as never, url: `https://flow.google.com/?p=${profileDir}`, authInProgress: false }),
    } as unknown as ChromeManager;
    const standaloneStore = new AccountStore(standaloneCfg);
    const makeStandalone = () => ({ store: standaloneStore, chrome: fakeChrome });

    await runLoginCli([], { getConfig: () => standaloneCfg, probeHealth: async () => "free", createStandalone: makeStandalone, log: (m) => logs.push(m) });
    await assert.rejects(
      () => runLoginCli(["Absent"], { getConfig: () => standaloneCfg, probeHealth: async () => "free", createStandalone: makeStandalone, log: (m) => logs.push(m) }),
      /Pass --create/,
    );
    await runLoginCli(["Backup S", "--create"], {
      getConfig: () => standaloneCfg,
      probeHealth: async () => "free",
      createStandalone: makeStandalone,
      log: (m) => logs.push(m),
    });
    assert.equal(standaloneStore.requireActiveAccount().label, "Backup S");

    // Disabled target refuses standalone login
    standaloneStore.enableAccount({ id: "default" }, false);
    await assert.rejects(
      () => runLoginCli(["Primary"], { getConfig: () => standaloneCfg, probeHealth: async () => "free", createStandalone: makeStandalone, log: (m) => logs.push(m) }),
      /disabled/,
    );
    // Existing enabled target switches back
    standaloneStore.enableAccount({ id: "default" }, true);
    await runLoginCli(["Primary"], {
      getConfig: () => standaloneCfg,
      probeHealth: async () => "free",
      createStandalone: makeStandalone,
      log: (m) => logs.push(m),
    });
    assert.equal(standaloneStore.requireActiveAccount().id, "default");

    // Failed standalone launch must NOT mutate activeAccountId
    const failStandalone = () => ({
      store: standaloneStore,
      chrome: {
        launchForLogin: async () => {
          throw new AppError(503, ERROR_CODES.PROFILE_LOCKED, "locked");
        },
      } as unknown as ChromeManager,
    });
    await assert.rejects(
      () => runLoginCli(["Backup S"], { getConfig: () => standaloneCfg, probeHealth: async () => "free", createStandalone: failStandalone, log: (m) => logs.push(m) }),
      /locked/,
    );
    assert.equal(standaloneStore.requireActiveAccount().id, "default");

    // Cover defaultProbeHealth & default createRemote / createStandalone
    const healthSrv = createServer((req, res) => {
      if (req.url === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ name: "flow-mcp" }));
      } else {
        res.writeHead(500).end("{}");
      }
    });
    await new Promise<void>((r) => healthSrv.listen(0, "127.0.0.1", r));
    const hPort = (healthSrv.address() as { port: number }).port;
    const hCfg = getConfig({ FLOW_MCP_HOME: join(root, "dh"), FLOW_MCP_PORT: String(hPort) });
    mkdirSync(hCfg.homeDir, { recursive: true });
    writeFileSync(hCfg.tokenFile, "t");
    try {
      await assert.rejects(() => runLoginCli([], { getConfig: () => hCfg, log: () => {} }));
    } finally {
      await new Promise<void>((r) => healthSrv.close(() => r()));
    }

    const otherSrv = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("not-json");
    });
    await new Promise<void>((r) => otherSrv.listen(0, "127.0.0.1", r));
    const oPort = (otherSrv.address() as { port: number }).port;
    try {
      await assert.rejects(
        () => runLoginCli([], { getConfig: () => getConfig({ FLOW_MCP_HOME: join(root, "oh"), FLOW_MCP_PORT: String(oPort) }), log: () => {} }),
        /used by another program/,
      );
    } finally {
      await new Promise<void>((r) => otherSrv.close(() => r()));
    }

    // Default standalone with non-CDP stub on cdpPort fails instantly in 2ms without spawning real Chrome
    const nonCdpSrv = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ notCdp: true }));
    });
    await new Promise<void>((r) => nonCdpSrv.listen(0, "127.0.0.1", r));
    const cdpPort = (nonCdpSrv.address() as { port: number }).port;
    try {
      await assert.rejects(
        () =>
          runLoginCli([], {
            getConfig: () => getConfig({ FLOW_MCP_HOME: join(root, "free-h"), FLOW_MCP_PORT: "1", FLOW_MCP_CDP_PORT: String(cdpPort) }),
          }),
        /blocking Flow Studio/,
      );
      // Also exercise defaultDeps().log directly via stdout capture
      const origLog = console.log;
      console.log = () => {};
      try {
        await runLoginCli([], {
          getConfig: () => standaloneCfg,
          probeHealth: async () => "free",
          createStandalone: makeStandalone,
        });
      } finally {
        console.log = origLog;
      }
    } finally {
      await new Promise<void>((r) => nonCdpSrv.close(() => r()));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
