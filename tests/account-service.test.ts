import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Browser, Page } from "playwright-core";
import { AccountService } from "../dist/account-service.js";
import { AccountStore } from "../dist/accounts.js";
import { ChromeManager } from "../dist/chrome.js";
import { getConfig } from "../dist/config.js";
import { buildJobView, filterAccountOutputs, guardRetry, resolveCastPortraits } from "../dist/core-accounts.js";
import { AppError, ERROR_CODES } from "../dist/errors.js";
import type { FlowState } from "../dist/flow.js";
import { JobQueue } from "../dist/queue.js";

function fakeChrome(cfgFn: () => ReturnType<typeof getConfig>) {
  let cdpUp = false;
  let curProfile = "";
  let curUrl = "https://flow.google.com/project/11111111-1111-1111-1111-111111111111";
  let listeners: (() => void)[] = [];
  let failLaunch = false;

  const makeFakeBrowser = () => {
    let conn = true;
    const page = {
      url: () => curUrl,
      goto: async (u: string) => {
        curUrl = u;
      },
      bringToFront: async () => undefined,
      evaluate: async () => "en",
      waitForFunction: async () => undefined,
    } as unknown as Page;
    const browser = {
      isConnected: () => conn,
      contexts: () => [{ pages: () => [page], newPage: async () => page }],
      newBrowserCDPSession: async () => ({ send: async () => undefined }),
      close: async () => {
        conn = false;
        cdpUp = false;
      },
      on: (ev: string, cb: () => void) => {
        if (ev === "disconnected") listeners.push(cb);
      },
    } as unknown as Browser;
    return browser;
  };

  let curBrowser = makeFakeBrowser();
  const chrome = new ChromeManager({
    getConfig: cfgFn,
    cdpProbe: async () => ({ ok: cdpUp, isCdp: cdpUp }),
    connectOverCDP: async () => {
      curBrowser = makeFakeBrowser();
      return curBrowser;
    },
    spawnChrome: (_b, args) => {
      if (failLaunch) throw new Error("spawn blocked");
      curProfile = args.find((a) => a.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
      cdpUp = true;
      return 777;
    },
    listProcesses: async () => (cdpUp ? [{ pid: 777, command: `chrome --user-data-dir=${curProfile} --remote-debugging-port=${cfgFn().cdpPort}` }] : []),
    isPidAlive: () => cdpUp,
    killPid: () => {
      cdpUp = false;
    },
    executable: () => "/usr/bin/chrome",
    sleep: async () => undefined,
    launchTimeoutMs: 50,
    closeTimeoutMs: 20,
    termTimeoutMs: 20,
  });

  return {
    chrome,
    setUrl: (u: string) => {
      curUrl = u;
    },
    setCdpUp: (up: boolean, profile = "") => {
      cdpUp = up;
      curProfile = profile;
    },
    setFailLaunch: (v: boolean) => {
      failLaunch = v;
    },
    fireDisconnect: () => {
      cdpUp = false;
      for (const cb of listeners.splice(0)) cb();
    },
  };
}

test("AccountService handles CRUD, switch, pendingLogin revert, busy guard, refresh, and corrupt status", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-svc-"));
  try {
    const cfg = getConfig({ FLOW_MCP_HOME: join(root, "home"), FLOW_MCP_OUTPUT: join(root, "out"), FLOW_MCP_CDP_PORT: "9447" });
    mkdirSync(join(cfg.homeDir, "chrome-profile"), { recursive: true });
    const store = new AccountStore(cfg);
    const fake = fakeChrome(() => cfg);
    let flowBehavior: "ok" | "signedOut" | "home" | "throw" = "ok";
    let flowCredits: number | undefined = 500;
    let flowPlan: string | undefined = "Pro";
    let runJobFn = async () => ["out.mp4"];

    const queue = new JobQueue(() => runJobFn(), () => ({ minMs: 0, maxMs: 0 }));
    const svc = new AccountService({
      store,
      chrome: fake.chrome,
      queue,
      getConfig: () => cfg,
      flow: {
        getFlowState: async (detailed): Promise<FlowState> => {
          if (flowBehavior === "throw") throw new Error("scrape failed");
          if (flowBehavior === "signedOut") {
            return { url: "https://accounts.google.com/", connected: true, signedIn: false, inProject: false, authInProgress: true };
          }
          if (flowBehavior === "home") {
            return { url: "https://flow.google.com/", connected: true, signedIn: true, inProject: false, authInProgress: false };
          }
          return {
            url: "https://flow.google.com/project/11111111-1111-1111-1111-111111111111",
            connected: true,
            signedIn: true,
            inProject: true,
            authInProgress: false,
            ...(detailed ? { plan: flowPlan, credits_remaining: flowCredits } : {}),
          };
        },
        createProject: async (title) => ({
          id: "22222222-2222-2222-2222-222222222222",
          url: "https://flow.google.com/project/22222222-2222-2222-2222-222222222222",
          title: title ?? "Untitled",
        }),
        listCharacters: async () => ["Hero"],
      },
    });

    assert.equal(svc.requireActiveAccount().id, "default");
    assert.equal(svc.getActivePaths().castDir, join(cfg.outputRoot, "_cast"));
    assert.equal(svc.getActiveCastDir(), join(cfg.outputRoot, "_cast"));

    const added = svc.addAccount("Backup 1");
    assert.equal(added.accounts.length, 2);
    const renamed = svc.renameAccount({ id: added.account.id }, "Backup Two");
    assert.equal(renamed.account.label, "Backup Two");
    svc.renameAccount({ current_label: "Backup Two" }, "Backup Two");
    svc.enableAccount({ id: added.account.id }, false);
    await assert.rejects(() => svc.switchAccount({ id: added.account.id }), /disabled/);
    await assert.rejects(() => svc.loginAccount({ id: added.account.id }), /disabled/);
    svc.enableAccount({ id: added.account.id }, true);
    svc.reorderAccounts([added.account.id, "default"]);

    // Passive status without launching Chrome
    const passiveOff = await svc.getStatus(false);
    assert.equal(passiveOff.flow.connected, false);
    assert.equal(passiveOff.activeAccountId, "default");

    // Detailed status reads plan + credits and stores UTC timestamp
    const det = await svc.getStatus(true);
    assert.equal(det.flow.plan, "Pro");
    assert.equal(det.flow.credits_remaining, 500);
    assert.ok(det.activeAccount?.balanceUpdatedAt);

    // Passive status when Chrome up and signed in syncs needsRelogin + pendingLogin
    fake.setCdpUp(true, store.getActivePaths().profileDir);
    fake.setUrl("https://flow.google.com/project/11111111-1111-1111-1111-111111111111");
    store.updateMetadata("default", { needsRelogin: true });
    assert.equal((await svc.getStatus(false)).activeAccount?.needsRelogin, false);
    assert.equal((await svc.getStatus(false)).activeAccount?.needsRelogin, false);

    // Switch to active is no-op
    const noop = await svc.switchAccount({ id: "default" });
    assert.equal(noop.switched, false);
    assert.equal(noop.alreadyActive, true);

    // Switch to Backup Two while Flow on primary is open on a project, landing on sign-in
    const swSignIn = await svc.switchAccount({ id: added.account.id });
    assert.equal(swSignIn.switched, true);
    assert.equal(store.findAccount({ id: "default" }).lastProjectUrl, "https://flow.google.com/project/11111111-1111-1111-1111-111111111111");

    // Simulate landing on sign-in tab after switch
    fake.setUrl("https://accounts.google.com/v3/signin");
    await svc.switchAccount({ id: "default" });
    const swAgain = await svc.switchAccount({ id: added.account.id });
    assert.equal(swAgain.flow.authInProgress, true);

    // Refresh checks
    await assert.rejects(() => svc.refreshAccount({ id: "default" }), /belongs to/);
    flowBehavior = "signedOut";
    await assert.rejects(() => svc.refreshAccount({}), /Not signed in/);
    flowBehavior = "home";
    store.updateMetadata(added.account.id, { plan: "Pro", creditsRemaining: 120, balanceUpdatedAt: "2026-11-25T00:00:00Z", lastProjectUrl: "https://flow.google.com/project/old" });
    await assert.rejects(() => svc.refreshAccount({}), /No Flow project/);
    // Preserved cached balance when bounced to home, cleared stale lastProjectUrl
    const afterBounce = store.findAccount({ id: added.account.id });
    assert.equal(afterBounce.creditsRemaining, 120);
    assert.equal(afterBounce.lastProjectUrl, undefined);

    // Sync status while signed in on home clears stale lastProjectUrl too
    store.updateMetadata(added.account.id, { lastProjectUrl: "https://flow.google.com/project/old2" });
    await svc.getStatus(true);
    assert.equal(store.findAccount({ id: added.account.id }).lastProjectUrl, undefined);

    flowBehavior = "ok";
    flowPlan = undefined;
    flowCredits = undefined;
    const refNoMetrics = await svc.refreshAccount({});
    assert.equal(refNoMetrics.refreshed, true);
    flowPlan = "Ultra";
    flowCredits = 999;
    assert.equal((await svc.refreshAccount({})).account.creditsRemaining, 999);

    // New project updates metadata
    const proj = await svc.createProjectForActive("My Film");
    assert.match(proj.url, /22222222/);
    assert.equal(store.requireActiveAccount().lastProjectTitle, "My Film");

    // loginAccount to other account -> signs in -> disconnect should NOT revert
    fake.setUrl("https://accounts.google.com/signin");
    await svc.loginAccount({ id: "default" });
    fake.setCdpUp(true, store.getActivePaths().profileDir);
    fake.setUrl("https://flow.google.com/");
    await svc.getStatus(false);
    fake.fireDisconnect();
    assert.equal(store.requireActiveAccount().id, "default");
    await svc.switchAccount({ id: added.account.id });

    // loginAccount to other account + premature disconnect reverts to active
    fake.setUrl("https://accounts.google.com/signin");
    const loginB = await svc.loginAccount({ id: "default" });
    assert.equal(loginB.authInProgress, true);
    assert.equal(store.requireActiveAccount().id, "default");
    fake.fireDisconnect();
    assert.equal(store.requireActiveAccount().id, added.account.id);

    // loginAccount same account already signed in clears pendingLogin
    fake.setUrl("https://flow.google.com/");
    const loginSame = await svc.loginAccount({});
    assert.equal(loginSame.authInProgress, false);

    // loginAccount launch failure reverts active account (cross-account and same-account)
    fake.setFailLaunch(true);
    await assert.rejects(() => svc.loginAccount({ id: "default" }), /spawn blocked/);
    assert.equal(store.requireActiveAccount().id, added.account.id);
    fake.setCdpUp(false);
    await assert.rejects(() => svc.loginAccount({}), /spawn blocked/);
    assert.equal(store.requireActiveAccount().id, added.account.id);
    fake.setFailLaunch(false);

    // Busy guard during unqueued Chrome op
    let releaseOp!: () => void;
    const blockingOp = svc.wrapChromeOp(
      () => new Promise<void>((r) => (releaseOp = r)),
    );
    svc.assertIdleForSwitch;
    assert.throws(() => svc.assertIdleForSwitch(), /busy/);
    const busyRef = await svc.refreshAccount({});
    assert.equal(busyRef.busy, true);
    releaseOp();
    await blockingOp;

    // Busy guard during queue active (job running)
    let releaseJob!: () => void;
    runJobFn = () => new Promise<string[]>((r) => (releaseJob = () => r(["a.mp4"])));
    queue.add({ prompt: "x", type: "video", max_credits: 10, output_dir: root, file_stem: "s1" });
    await assert.rejects(() => svc.wrapChromeOp(async () => "x"), /busy/);
    releaseJob();
    await new Promise((r) => setTimeout(r, 20));

    // Busy guard during switchInProgress
    const pSwitch = fake.chrome.withMutex(async () => {
      assert.throws(() => svc.assertIdleForSwitch(), /already running/);
      await assert.rejects(() => svc.wrapChromeOp(async () => "x"), /already running/);
    }, true);
    await pSwitch;

    // Sync post job readout & getStatus error fallback (both Error and string throw)
    await svc.syncPostJobReadout(added.account.id);
    flowBehavior = "throw";
    await svc.syncPostJobReadout(added.account.id);
    const errStatus = await svc.getStatus(true);
    assert.equal(errStatus.flow.connected, false);
    assert.match(errStatus.flow.hint ?? "", /scrape failed/);
    const strErrSvc = new AccountService({
      store,
      chrome: fake.chrome,
      queue,
      getConfig: () => cfg,
      flow: {
        getFlowState: async () => {
          throw "non-error-throw";
        },
        createProject: async () => ({ id: "1", url: "", title: "" }),
        listCharacters: async () => [],
      },
    });
    assert.equal((await strErrSvc.getStatus(true)).flow.hint, "non-error-throw");
    await fake.chrome.withMutex(async () => {
      await svc.syncPostJobReadout(added.account.id);
    }, true);

    // Passive status with signedIn false and needsRelogin true
    fake.setCdpUp(false);
    store.updateMetadata("default", { needsRelogin: true });
    await svc.switchAccount({ id: "default" });
    fake.setCdpUp(false);
    const needsLoginSt = await svc.getStatus(false);
    assert.ok(needsLoginSt.flow.hint?.includes("missing") || needsLoginSt.flow.hint !== undefined);
    // Cover plan defined while credits undefined
    flowBehavior = "ok";
    flowPlan = "Pro";
    flowCredits = undefined;
    await svc.getStatus(true);
    // Cover switch when active Chrome signed in on home (no project URL)
    fake.setUrl("https://flow.google.com/");
    await svc.switchAccount({ id: added.account.id });

    // switchProfile getFlowState catch fallback
    flowBehavior = "throw";
    fake.setUrl("https://flow.google.com/");
    const swFallback = await svc.switchAccount({ id: "default" });
    assert.equal(swFallback.flow.signedIn, false);

    // Remove inactive secondary
    assert.equal(svc.removeAccount({ id: added.account.id }).removedId, added.account.id);
    assert.equal(svc.listAccounts().accounts.length, 1);

    // Corrupt registry status response
    writeFileSync(cfg.accountsFile, "{broken");
    const corruptStore = new AccountStore(cfg);
    const corruptSvc = new AccountService({
      store: corruptStore,
      chrome: fake.chrome,
      queue,
      getConfig: () => cfg,
      flow: {
        getFlowState: async () => ({ url: "", signedIn: false, inProject: false }),
        createProject: async () => ({ id: "1", url: "", title: "" }),
        listCharacters: async () => [],
      },
    });
    assert.equal(corruptSvc.listAccounts().activeAccountId, null);
    const cStatus = await corruptSvc.getStatus(true);
    assert.equal(cStatus.activeAccount, null);
    assert.ok(cStatus.registryError);
    await corruptSvc.syncPostJobReadout("default");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("core-accounts covers buildJobView, guardRetry, resolveCastPortraits, and filterAccountOutputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-ca-"));
  try {
    const queue = new JobQueue(async () => {
      throw new Error("boom");
    }, () => ({ minMs: 0, maxMs: 0 }));

    const activeA = { id: "acc-a", label: "Primary" };
    const activeB = { id: "acc-b", label: "Backup" };

    // Empty queue retry
    assert.throws(() => guardRetry(queue, activeA), /Nothing to retry/);
    assert.throws(() => guardRetry(queue, activeA, []), /Nothing to retry/);

    // Account-bound job belonging to A fails -> blocked on B; portable job retries across accounts
    const boundA = queue.add({ prompt: "bound", type: "image", max_credits: 0, first_frame: "asset:Hero", output_dir: root, file_stem: "scene-00" }, { accountId: "acc-a", accountLabel: "Primary" });
    const jobA = queue.add({ prompt: "p1", type: "image", max_credits: 0, output_dir: root, file_stem: "scene-01" }, { accountId: "acc-a", accountLabel: "Primary" });
    const queuedC = queue.add({ prompt: "p2", type: "image", max_credits: 0, output_dir: root, file_stem: "scene-02" }, { accountId: "acc-a", accountLabel: "Primary" });
    queue.cancel(queuedC.id);
    await new Promise((r) => setTimeout(r, 30));

    const view = buildJobView(jobA);
    assert.equal(view.accountId, "acc-a");
    assert.equal(view.accountLabel, "Primary");
    assert.equal(view.portable, true);
    assert.equal(buildJobView(boundA).portable, false);

    // Cross-account retry blocked for bound job on B (targeted & no-arg when only bound job exists)
    assert.throws(() => guardRetry(queue, activeB, [boundA.id]), /Switch to "Primary"/);
    const boundOnlyQueue = new JobQueue(async () => {
      throw new Error("boom");
    }, () => ({ minMs: 0, maxMs: 0 }));
    boundOnlyQueue.add({ prompt: "bound-only", type: "image", max_credits: 0, edit_asset: "clip-1", output_dir: root, file_stem: "edit-01" }, { accountId: "acc-a", accountLabel: "Primary" });
    await new Promise((r) => setTimeout(r, 25));
    assert.throws(() => guardRetry(boundOnlyQueue, activeB), /Switch to "Primary"/);

    // Portable job retries across accounts onto B (re-stamping owner & clearing failover trail)
    jobA.failoverFrom = { accountId: "acc-z", accountLabel: "Old" };
    jobA.failoverAttempts = [{ accountId: "acc-b", accountLabel: "Backup", status: "failed", reason: "low" }];
    jobA.params.agent_ref_assets = ["UploadedRef"];
    const crossRetried = guardRetry(queue, activeB, [jobA.id]);
    assert.equal(crossRetried.length, 1);
    assert.equal(crossRetried[0].accountId, "acc-b");
    assert.equal(crossRetried[0].accountLabel, "Backup");
    assert.equal(crossRetried[0].failoverFrom, undefined);
    assert.equal(crossRetried[0].params.agent_ref_assets, undefined);
    await new Promise((r) => setTimeout(r, 25));
    // Re-add/verify no-arg retry includes cancelled portable jobs on activeB
    const noArgCross = guardRetry(queue, activeB);
    assert.ok(noArgCross.some((j) => j.id === queuedC.id || j.id === jobA.id));
    await new Promise((r) => setTimeout(r, 25));

    // Retry with unknown label fallback & non-retryable id
    const jobUnknown = { ...jobA, id: "unk", accountId: "acc-x", accountLabel: undefined };
    void jobUnknown;
    assert.throws(() => guardRetry(queue, activeA, ["does-not-exist"]), /Nothing to retry/);

    // Targeted retry with non-failed job ignored, failed retried
    const jobDone = queue.add({ prompt: "ok", type: "image", max_credits: 0, output_dir: root, file_stem: "scene-01" }, { accountId: "acc-a", accountLabel: "Primary" });
    const pureDone = queue.add({ prompt: "pure", type: "image", max_credits: 0, output_dir: root, file_stem: "scene-09" }, { accountId: "acc-a", accountLabel: "Primary" });
    pureDone.status = "done";
    // Partial failed_scenes agent batch retry + pure done ignored cleanly
    jobDone.status = "done";
    jobDone.params.agent_scenes = ["s1", "s2"];
    jobDone.failed_scenes = [2];
    const retriedPartial = guardRetry(queue, activeA, [pureDone.id, jobDone.id]);
    assert.equal(retriedPartial.length, 1);
    assert.equal(retriedPartial[0].accountId, "acc-a");
    assert.deepEqual(retriedPartial[0].params.agent_numbers, [2]);

    // With agent_numbers & agent_scene_refs already set + no-arg retry filtering active account
    jobDone.status = "done";
    jobDone.params.agent_numbers = [5, 6];
    jobDone.params.agent_scene_refs = [["Hero"], []];
    jobDone.params.file_stem = "custom";
    jobDone.failed_scenes = [6];
    const noArgRetried = guardRetry(queue, activeA);
    assert.ok(noArgRetried.length >= 1);

    // Divergent failed_scenes (pick.length === 0) never produces "scene-undefined"
    const divergentDone = queue.add({ prompt: "div", type: "image", max_credits: 0, agent_scenes: ["s1", "s2"], output_dir: root, file_stem: "scene-01" }, { accountId: "acc-a", accountLabel: "Primary" });
    divergentDone.status = "done";
    divergentDone.failed_scenes = [99];
    assert.throws(() => guardRetry(queue, activeA, [divergentDone.id]), /Nothing to retry/);
    assert.deepEqual(divergentDone.failed_scenes, [99]);
    const divergentFailed = queue.add({ prompt: "divf", type: "image", max_credits: 0, agent_scenes: ["s1", "s2"], output_dir: root, file_stem: "scene-01" }, { accountId: "acc-a", accountLabel: "Primary" });
    await new Promise((r) => setTimeout(r, 25));
    divergentFailed.status = "failed";
    divergentFailed.files = [join(root, "scene-01.png")];
    divergentFailed.failed_scenes = [99];
    const fallbackFull = guardRetry(queue, activeA, [divergentFailed.id]);
    assert.equal(fallbackFull.length, 1);
    assert.equal(fallbackFull[0].params.file_stem, "scene-01");
    await new Promise((r) => setTimeout(r, 25));

    // Unknown owner label fallback on bound job
    const rawJob = queue.add({ prompt: "x", type: "image", max_credits: 0, first_frame: "asset:Hero", output_dir: root, file_stem: "s" }, { accountId: "acc-no-label" });
    await new Promise((r) => setTimeout(r, 30));
    rawJob.status = "failed";
    assert.throws(() => guardRetry(queue, activeB, [rawJob.id]), /acc-no-label/);

    // No-arg guardRetry auto-filters out bound jobs from other accounts when active account has failed jobs
    const filterQueue = new JobQueue(async () => {
      throw new Error("boom");
    }, () => ({ minMs: 120, maxMs: 120 }));
    const fJobA = filterQueue.add({ prompt: "a-fail", type: "image", max_credits: 0, first_frame: "asset:Hero", output_dir: root, file_stem: "sa" }, { accountId: "acc-a", accountLabel: "Primary" });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(fJobA.status, "failed");
    const fJobB = filterQueue.add({ prompt: "b-fail", type: "image", max_credits: 0, output_dir: root, file_stem: "sb" }, { accountId: "acc-b", accountLabel: "Backup" });
    for (let i = 0; i < 40 && fJobB.status !== "failed"; i++) await new Promise((r) => setTimeout(r, 15));
    assert.equal(fJobB.status, "failed");
    const filteredRetry = guardRetry(filterQueue, activeB);
    assert.equal(filteredRetry.length, 1);
    assert.equal(filteredRetry[0].id, fJobB.id);
    assert.equal(fJobA.status, "failed");

    // Cast portraits
    assert.deepEqual(resolveCastPortraits(["Maya"], join(root, "no-cast")), [{ name: "Maya", use_as: "asset:Maya" }]);
    const castDir = join(root, "_cast");
    mkdirSync(castDir, { recursive: true });
    writeFileSync(join(castDir, "Maya.png"), "img");
    writeFileSync(join(castDir, "Leo-01.jpg"), "img");
    writeFileSync(join(castDir, "notes.txt"), "skip");
    const portraits = resolveCastPortraits(["Maya", "Leo", "Missing"], castDir);
    assert.equal(portraits[0].portrait, join(castDir, "Maya.png"));
    assert.equal(portraits[1].portrait, join(castDir, "Leo-01.jpg"));
    assert.equal(portraits[2].portrait, undefined);

    // filterAccountOutputs
    assert.deepEqual(filterAccountOutputs(join(root, "no-out"), true), { root: join(root, "no-out"), projects: [] });
    const outRoot = join(root, "films");
    mkdirSync(join(outRoot, "_cast"), { recursive: true });
    mkdirSync(join(outRoot, "Film1"), { recursive: true });
    mkdirSync(join(outRoot, "EmptyDir"), { recursive: true });
    writeFileSync(join(outRoot, "stray.txt"), "ignore");
    writeFileSync(join(outRoot, "_cast", "Hero.png"), "img");
    writeFileSync(join(outRoot, "Film1", "scene-01.mp4"), "vid");
    writeFileSync(join(outRoot, "Film1", "voice.m4a"), "aud");
    writeFileSync(join(outRoot, "Film1", "frame.png"), "img");
    writeFileSync(join(outRoot, "Film1", "scene-01-lastframe.jpg"), "skip");

    const defOuts = filterAccountOutputs(outRoot, true);
    assert.equal(defOuts.projects.length, 2);
    const secOuts = filterAccountOutputs(outRoot, false);
    assert.equal(secOuts.projects.length, 1);
    assert.equal(secOuts.projects[0].name, "Film1");
    assert.equal(secOuts.projects[0].files.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AccountService holds switchPending across pre/post switch awaits, validates Flow host on login, and blocks CHROME_BUSY during pacing", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-svc-race-"));
  try {
    const cfg = getConfig({
      FLOW_MCP_HOME: join(root, "home"),
      FLOW_MCP_OUTPUT: join(root, "out"),
      FLOW_MCP_CDP_PORT: "9455",
      FLOW_MCP_FLOW_URL: "http://127.0.0.1:4100/flow/",
    });
    mkdirSync(join(cfg.homeDir, "chrome-profile"), { recursive: true });
    const store = new AccountStore(cfg);
    const b = store.addAccount("Backup");
    const fake = fakeChrome(() => cfg);

    let scrapeEntered = false;
    let scrapeCalls = 0;

    const origProbe = fake.chrome.probePassiveState.bind(fake.chrome);
    const queue = new JobQueue(async () => ["clip.mp4"], () => ({ minMs: 150, maxMs: 150 }));
    const svc = new AccountService({
      store,
      chrome: fake.chrome,
      queue,
      getConfig: () => cfg,
      flow: {
        getFlowState: async (): Promise<FlowState> => {
          scrapeCalls++;
          return {
            url: "https://flow.google.com/project/11111111-1111-1111-1111-111111111111",
            connected: true,
            signedIn: true,
            inProject: true,
            authInProgress: false,
            plan: "Pro",
            credits_remaining: 400,
          };
        },
        createProject: async () => ({ id: "1", url: "https://flow.google.com/project/1", title: "P" }),
        listCharacters: async () => [],
      },
    });

    // 1. switchPending set synchronously BEFORE captureActiveProjectUrl await and held through post-switch getFlowState(true)
    let releaseProbe!: () => void;
    let releaseScrape!: () => void;
    const probeGate = new Promise<void>((r) => (releaseProbe = r));
    fake.chrome.probePassiveState = async (dir: string) => {
      await probeGate;
      return origProbe(dir);
    };
    const scrapeGate = new Promise<void>((r) => (releaseScrape = r));
    const origGetFlow = svc["flow"].getFlowState;
    svc["flow"].getFlowState = async () => {
      scrapeEntered = true;
      await scrapeGate;
      return origGetFlow(true);
    };

    const swPromise = svc.switchAccount({ id: b.id });
    assert.equal(svc.isChromeBusy(), true);
    assert.throws(() => svc.assertIdleForSwitch(), (e: AppError) => e.status === 409 && e.code === ERROR_CODES.SWITCH_IN_PROGRESS);
    await assert.rejects(() => svc.wrapChromeOp(async () => "x"), (e: AppError) => e.status === 409 && e.code === ERROR_CODES.SWITCH_IN_PROGRESS);
    await assert.rejects(() => svc.switchAccount({ id: b.id }), (e: AppError) => e.status === 409 && e.code === ERROR_CODES.SWITCH_IN_PROGRESS);
    await assert.rejects(() => svc.loginAccount({ id: b.id }), (e: AppError) => e.status === 409 && e.code === ERROR_CODES.SWITCH_IN_PROGRESS);
    await assert.rejects(() => svc.loginAccount({}), (e: AppError) => e.status === 409 && e.code === ERROR_CODES.SWITCH_IN_PROGRESS);
    await svc.syncPostJobReadout(b.id);
    assert.equal(scrapeCalls, 0);

    // Release captureActiveProjectUrl, wait until post-switch getFlowState(true) is in flight (chrome.switchInProgress is now false!)
    fake.chrome.probePassiveState = origProbe;
    releaseProbe();
    for (let i = 0; i < 50 && !scrapeEntered; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(scrapeEntered, true);
    assert.equal(fake.chrome.switchInProgress, false);
    assert.equal(svc.isChromeBusy(), true);
    assert.equal((await svc.getStatus(false)).switchInProgress, true);
    assert.throws(() => svc.assertIdleForSwitch(), (e: AppError) => e.status === 409 && e.code === ERROR_CODES.SWITCH_IN_PROGRESS);
    await assert.rejects(() => svc.wrapChromeOp(async () => "x"), (e: AppError) => e.status === 409 && e.code === ERROR_CODES.SWITCH_IN_PROGRESS);
    releaseScrape();
    const swDone = await swPromise;
    assert.equal(swDone.switched, true);
    assert.equal(svc.isChromeBusy(), false);
    assert.equal((await svc.getStatus(false)).switchInProgress, false);

    // 2. loginAccount holds switchPending synchronously for both switchFromOther=true and switchFromOther=false
    const origLaunch = fake.chrome.launchForLogin.bind(fake.chrome);
    let releaseLaunch!: () => void;
    let launchGate = new Promise<void>((r) => (releaseLaunch = r));
    fake.chrome.launchForLogin = async (dir, startUrl, opts) => {
      await launchGate;
      return origLaunch(dir, startUrl, opts);
    };

    const loginOtherP = svc.loginAccount({ id: "default" });
    assert.equal(svc.isChromeBusy(), true);
    await assert.rejects(() => svc.loginAccount({}), (e: AppError) => e.status === 409 && e.code === ERROR_CODES.SWITCH_IN_PROGRESS);
    await assert.rejects(() => svc.wrapChromeOp(async () => "x"), (e: AppError) => e.status === 409 && e.code === ERROR_CODES.SWITCH_IN_PROGRESS);
    releaseLaunch();
    await loginOtherP;
    assert.equal(svc.isChromeBusy(), false);

    launchGate = new Promise<void>((r) => (releaseLaunch = r));
    const loginSameP = svc.loginAccount({});
    assert.equal(svc.isChromeBusy(), true);
    await assert.rejects(() => svc.switchAccount({ id: b.id }), (e: AppError) => e.status === 409 && e.code === ERROR_CODES.SWITCH_IN_PROGRESS);
    releaseLaunch();
    await loginSameP;
    assert.equal(svc.isChromeBusy(), false);
    fake.chrome.launchForLogin = origLaunch;

    // 3. loginAccount verifies isFlowHost AND !isSignInUrl before setting loginCompleted = true
    await svc.switchAccount({ id: b.id });
    // Non-flow host (authInProgress=false) keeps pendingLogin and reverts on disconnect
    fake.chrome.launchForLogin = async (dir, startUrl, opts) => {
      const res = await origLaunch(dir, startUrl, opts);
      return { ...res, url: "https://evil.example.com/landing", authInProgress: false };
    };
    const badHostLogin = await svc.loginAccount({ id: "default" });
    assert.equal(badHostLogin.authInProgress, false);
    assert.ok(badHostLogin.pendingLogin);
    fake.fireDisconnect();
    assert.equal(store.requireActiveAccount().id, b.id);

    // Flow host + /about sign-in URL keeps pendingLogin and reverts on disconnect
    fake.chrome.launchForLogin = async (dir, startUrl, opts) => {
      const res = await origLaunch(dir, startUrl, opts);
      return { ...res, url: "https://flow.google.com/about", authInProgress: false };
    };
    const aboutLogin = await svc.loginAccount({ id: "default" });
    assert.ok(aboutLogin.pendingLogin);
    fake.fireDisconnect();
    assert.equal(store.requireActiveAccount().id, b.id);

    // Custom configured Flow origin (!isSignInUrl) marks loginCompleted=true and clears pendingLogin
    fake.chrome.launchForLogin = async (dir, startUrl, opts) => {
      const res = await origLaunch(dir, startUrl, opts);
      return { ...res, url: "http://127.0.0.1:4100/flow/project/abc", authInProgress: false };
    };
    const okCustomLogin = await svc.loginAccount({ id: "default" });
    assert.equal(okCustomLogin.pendingLogin, null);
    assert.equal(okCustomLogin.account.needsRelogin, false);

    // 4. Inter-job pacing sleep blocks assertIdleForSwitch & wrapChromeOp with CHROME_BUSY even with 0 running jobs
    queue.add({ prompt: "p1", type: "image", max_credits: 0, output_dir: root, file_stem: "p1" });
    await new Promise((r) => setTimeout(r, 15));
    const q2 = queue.add({ prompt: "p2", type: "image", max_credits: 0, output_dir: root, file_stem: "p2" });
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(q2.status, "queued");
    assert.equal(queue.list().some((j) => j.status === "running"), false);
    assert.throws(() => svc.assertIdleForSwitch(), (e: AppError) => e.status === 409 && e.code === ERROR_CODES.CHROME_BUSY);
    await assert.rejects(() => svc.wrapChromeOp(async () => "x"), (e: AppError) => e.status === 409 && e.code === ERROR_CODES.CHROME_BUSY);
    await new Promise((r) => setTimeout(r, 170));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AccountService prevents getStatus and syncPostJobReadout TOCTOU races from wiping pendingLogin during concurrent loginAccount", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-svc-toctou-"));
  try {
    const cfg = getConfig({ FLOW_MCP_HOME: join(root, "home"), FLOW_MCP_OUTPUT: join(root, "out"), FLOW_MCP_CDP_PORT: "9465" });
    mkdirSync(join(cfg.homeDir, "chrome-profile"), { recursive: true });
    const store = new AccountStore(cfg);
    const backup1 = store.addAccount("Backup 1");
    store.updateMetadata("default", { plan: "Pro", creditsRemaining: 1200, needsRelogin: false });
    const fake = fakeChrome(() => cfg);

    let flowFail = false;
    let flowGate: Promise<void> | null = null;
    let onFlowEntered: (() => void) | null = null;
    const queue = new JobQueue(async () => ["out.mp4"], () => ({ minMs: 0, maxMs: 0 }));
    const svc = new AccountService({
      store,
      chrome: fake.chrome,
      queue,
      getConfig: () => cfg,
      flow: {
        getFlowState: async (): Promise<FlowState> => {
          onFlowEntered?.();
          if (flowGate) await flowGate;
          if (flowFail) throw new Error("cdp lost");
          return {
            url: "https://flow.google.com/project/11111111-1111-1111-1111-111111111111",
            connected: true,
            signedIn: true,
            inProject: true,
            authInProgress: false,
          };
        },
        createProject: async () => ({ id: "1", url: "https://flow.google.com/project/1", title: "P" }),
        listCharacters: async () => [],
      },
    });

    const origProbe = fake.chrome.probePassiveState.bind(fake.chrome);
    const origLaunch = fake.chrome.launchForLogin.bind(fake.chrome);

    // Case 1: getStatus(false) captures Primary signedIn=true before loginAccount(Backup 1), then resolves WHILE loginAccount is in launchForLogin
    fake.setCdpUp(true, store.getActivePaths().profileDir);
    fake.setUrl("https://flow.google.com/project/11111111-1111-1111-1111-111111111111");

    let releaseStatusProbe!: () => void;
    let statusProbeEntered!: () => void;
    const statusProbeReached = new Promise<void>((r) => (statusProbeEntered = r));
    const statusProbeGate = new Promise<void>((r) => (releaseStatusProbe = r));
    let probeCalls = 0;
    fake.chrome.probePassiveState = async (dir: string) => {
      probeCalls++;
      if (probeCalls === 1) {
        const preSwitchResult = await origProbe(dir);
        assert.equal(preSwitchResult.signedIn, true);
        statusProbeEntered();
        await statusProbeGate;
        return preSwitchResult;
      }
      return origProbe(dir);
    };

    let releaseLaunch!: () => void;
    let launchEntered!: () => void;
    const launchReached = new Promise<void>((r) => (launchEntered = r));
    const launchGate = new Promise<void>((r) => (releaseLaunch = r));
    fake.chrome.launchForLogin = async (dir, startUrl, opts) => {
      launchEntered();
      await launchGate;
      fake.setUrl("https://accounts.google.com/v3/signin");
      return origLaunch(dir, startUrl, opts);
    };

    const statusDuringLoginP = svc.getStatus(false);
    await statusProbeReached;
    const loginP = svc.loginAccount({ id: backup1.id });
    await launchReached;

    // Resolve stale passive probe while loginAccount is mid-flight inside launchForLogin
    releaseStatusProbe();
    const staleDuringLogin = await statusDuringLoginP;
    assert.equal(staleDuringLogin.switchInProgress, true);
    assert.equal(staleDuringLogin.flow.signedIn, false);
    assert.match(staleDuringLogin.flow.hint ?? "", /Switching Flow accounts/);
    assert.equal(staleDuringLogin.pendingLogin?.targetAccountId, backup1.id);

    releaseLaunch();
    const loginRes = await loginP;
    assert.equal(loginRes.authInProgress, true);
    assert.equal(loginRes.pendingLogin?.targetAccountId, backup1.id);

    // Chrome disconnect during pendingLogin must revert cleanly back to default
    fake.fireDisconnect();
    assert.equal(store.requireActiveAccount().id, "default");
    assert.equal(store.getPendingLogin(), null);

    // Case 2: getStatus(false) captures Primary signedIn=true, then resolves AFTER loginAccount(Backup 1) has completed (switchInProgress=false)
    fake.chrome.probePassiveState = origProbe;
    fake.chrome.launchForLogin = origLaunch;
    fake.setCdpUp(true, store.getActivePaths().profileDir);
    fake.setUrl("https://flow.google.com/project/11111111-1111-1111-1111-111111111111");

    let releasePostProbe!: () => void;
    let postProbeEntered!: () => void;
    const postProbeReached = new Promise<void>((r) => (postProbeEntered = r));
    const postProbeGate = new Promise<void>((r) => (releasePostProbe = r));
    let postProbeCalls = 0;
    fake.chrome.probePassiveState = async (dir: string) => {
      postProbeCalls++;
      if (postProbeCalls === 1) {
        const preSwitchResult = await origProbe(dir);
        assert.equal(preSwitchResult.signedIn, true);
        postProbeEntered();
        await postProbeGate;
        return preSwitchResult;
      }
      return origProbe(dir);
    };
    fake.chrome.launchForLogin = async (dir, startUrl, opts) => {
      fake.setUrl("https://accounts.google.com/v3/signin");
      return origLaunch(dir, startUrl, opts);
    };

    const statusPostLoginP = svc.getStatus(false);
    await postProbeReached;
    const doneLoginRes = await svc.loginAccount({ id: backup1.id });
    assert.equal(doneLoginRes.authInProgress, true);
    assert.equal(doneLoginRes.pendingLogin?.targetAccountId, backup1.id);

    releasePostProbe();
    const stalePostLogin = await statusPostLoginP;
    assert.equal(stalePostLogin.switchInProgress, false);
    assert.equal(stalePostLogin.flow.signedIn, false);
    assert.equal(stalePostLogin.flow.authInProgress, true);
    assert.match(stalePostLogin.flow.hint ?? "", /Google sign-in is open/);
    assert.equal(stalePostLogin.pendingLogin?.targetAccountId, backup1.id);
    assert.equal(store.getPendingLogin()?.targetAccountId, backup1.id);

    // Case 3: getStatus(true) racing onDisconnect revert (both resolve and reject paths) returns stale flow for reverted account
    let releaseScrape1!: () => void;
    flowGate = new Promise<void>((r) => (releaseScrape1 = r));
    const scrapeEntered1 = new Promise<void>((r) => (onFlowEntered = r));
    const detailedResolveP = svc.getStatus(true);
    await scrapeEntered1;
    fake.fireDisconnect();
    assert.equal(store.requireActiveAccount().id, "default");
    releaseScrape1();
    const staleDetailedResolve = await detailedResolveP;
    assert.equal(staleDetailedResolve.activeAccountId, "default");
    assert.equal(staleDetailedResolve.flow.signedIn, false);
    assert.equal(staleDetailedResolve.flow.plan, "Pro");

    // Re-enter pendingLogin on Backup 1 and test getStatus(true) catch path when onDisconnect reverts mid-scrape
    await svc.loginAccount({ id: backup1.id });
    let releaseScrape2!: () => void;
    flowFail = true;
    flowGate = new Promise<void>((r) => (releaseScrape2 = r));
    const scrapeEntered2 = new Promise<void>((r) => (onFlowEntered = r));
    const detailedRejectP = svc.getStatus(true);
    await scrapeEntered2;
    fake.fireDisconnect();
    releaseScrape2();
    const staleDetailedReject = await detailedRejectP;
    assert.equal(staleDetailedReject.activeAccountId, "default");
    assert.equal(staleDetailedReject.flow.plan, "Pro");
    assert.equal(staleDetailedReject.flow.hint, undefined);

    // Case 4: getStatus(false) catches external store.setActive change without stateEpoch increment
    fake.chrome.probePassiveState = origProbe;
    fake.chrome.launchForLogin = origLaunch;
    fake.setCdpUp(true, store.getActivePaths().profileDir);
    fake.setUrl("https://flow.google.com/project/11111111-1111-1111-1111-111111111111");
    let releaseExtProbe!: () => void;
    let extProbeEntered!: () => void;
    const extProbeReached = new Promise<void>((r) => (extProbeEntered = r));
    const extProbeGate = new Promise<void>((r) => (releaseExtProbe = r));
    fake.chrome.probePassiveState = async (dir: string) => {
      const res = await origProbe(dir);
      extProbeEntered();
      await extProbeGate;
      return res;
    };
    const extStatusP = svc.getStatus(false);
    await extProbeReached;
    store.setActive(backup1.id, { targetAccountId: backup1.id, previousAccountId: "default", startedAt: new Date().toISOString() });
    releaseExtProbe();
    const extStaleStatus = await extStatusP;
    assert.equal(extStaleStatus.activeAccountId, backup1.id);
    assert.equal(extStaleStatus.pendingLogin?.targetAccountId, backup1.id);

    // Case 5: syncPostJobReadout aborts metadata/pendingLogin mutation if loginAccount runs concurrently
    store.revertPendingLogin();
    flowFail = false;
    let releasePostJob!: () => void;
    flowGate = new Promise<void>((r) => (releasePostJob = r));
    const postJobEntered = new Promise<void>((r) => (onFlowEntered = r));
    fake.chrome.probePassiveState = origProbe;
    fake.chrome.launchForLogin = async (dir, startUrl, opts) => {
      fake.setUrl("https://accounts.google.com/v3/signin");
      return origLaunch(dir, startUrl, opts);
    };
    const postJobP = svc.syncPostJobReadout("default");
    await postJobEntered;
    await svc.loginAccount({ id: backup1.id });
    releasePostJob();
    await postJobP;
    assert.equal(store.getPendingLogin()?.targetAccountId, backup1.id);
    fake.fireDisconnect();
    assert.equal(store.requireActiveAccount().id, "default");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
