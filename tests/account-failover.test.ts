import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Browser, Page } from "playwright-core";
import { AccountFailoverCoordinator } from "../dist/account-failover.js";
import {
  buildExhaustionPatch,
  buildFlowSyncPatch,
  classifyFailoverError,
  evaluateCandidateEligibility,
  EXHAUSTION_TTL_MS,
  isAccountExhaustedWithinTtl,
  isJobPortable,
  isTimestampFresh,
} from "../dist/account-failover-policy.js";
import { AccountService } from "../dist/account-service.js";
import { AccountStore } from "../dist/accounts.js";
import { ChromeManager } from "../dist/chrome.js";
import { getConfig } from "../dist/config.js";
import { defaultCoreMediaDeps, runQueuedJob } from "../dist/core-media.js";
import { LocalCore } from "../dist/core.js";
import { AppError, ERROR_CODES } from "../dist/errors.js";
import type { FlowState } from "../dist/flow.js";
import { CreditExhaustedError } from "../dist/flow-credits.js";
import { JobQueue, type SceneParams } from "../dist/queue.js";

function makeFakeChrome(opts: {
  getConfig: () => ReturnType<typeof getConfig>;
  initialProfile?: string;
  initialUrl?: string;
  failSwitchProfiles?: Map<string, () => Error>;
}) {
  let activeDir = opts.initialProfile ?? "";
  let cdpUp = Boolean(activeDir);
  let curUrl = opts.initialUrl ?? "https://flow.google.com/project/11111111-1111-1111-1111-111111111111";
  const switchedTo: string[] = [];

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
    isConnected: () => cdpUp,
    contexts: () => [{ pages: () => [page], newPage: async () => page }],
    newBrowserCDPSession: async () => ({ send: async () => undefined }),
    close: async () => {
      cdpUp = false;
    },
    on: () => undefined,
  } as unknown as Browser;

  const chrome = new ChromeManager({
    getConfig: opts.getConfig,
    cdpProbe: async () => ({ ok: cdpUp, isCdp: cdpUp }),
    connectOverCDP: async () => browser,
    spawnChrome: (_bin, args) => {
      const dirArg = args.find((a) => a.startsWith("--user-data-dir="))!;
      activeDir = dirArg.slice("--user-data-dir=".length);
      const urlArg = args[args.length - 1];
      if (urlArg) curUrl = urlArg;
      cdpUp = true;
      switchedTo.push(activeDir);
      return 4242;
    },
    listProcesses: async () =>
      cdpUp
        ? [{ pid: 4242, command: `chrome --user-data-dir=${activeDir} --remote-debugging-port=${opts.getConfig().cdpPort}` }]
        : [],
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

  const origSwitch = chrome.switchProfile.bind(chrome);
  chrome.switchProfile = async (dir: string, startUrl?: string) => {
    const failFn = opts.failSwitchProfiles?.get(dir);
    if (failFn) throw failFn();
    return origSwitch(dir, startUrl);
  };

  return {
    chrome,
    switchedTo,
    setUrl: (u: string) => {
      curUrl = u;
    },
    getActiveDir: () => activeDir,
    isUp: () => cdpUp,
  };
}

test("account-failover-policy covers portability, 24h TTL, cost-aware eligibility, exhaustion patches, and error matrix", () => {
  const base: SceneParams = { prompt: "p", type: "video", max_credits: 25, output_dir: "/tmp/out", file_stem: "scene-01" };
  assert.equal(isJobPortable(base), true);
  assert.equal(isJobPortable({ ...base, chain_from: "j1", reference_from: "j0", first_frame: "/tmp/a.png" }), true);
  assert.equal(isJobPortable({ ...base, edit_asset: "clip" }), false);
  assert.equal(isJobPortable({ ...base, continue_from: "clip" }), false);
  assert.equal(isJobPortable({ ...base, agent_ref_assets: ["fm-ref"] }), false);
  assert.equal(isJobPortable({ ...base, first_frame: "asset:Hero" }), false);
  assert.equal(isJobPortable({ ...base, last_frame: "asset:End" }), false);
  assert.equal(isJobPortable({ ...base, reference_images: ["/tmp/a.png", "asset:Cast"] }), false);
  assert.equal(isJobPortable({ ...base, agent_refs: [{ image: "asset:Cast", name: "Cast" }] }), false);
  assert.equal(isJobPortable({ ...base, agent_refs: [{ image: "/tmp/local.png", name: "Local" }] }), true);

  const t0 = Date.parse("2026-11-26T00:00:00.000Z");
  assert.equal(isTimestampFresh(undefined, t0), false);
  assert.equal(isTimestampFresh("bad-date", t0), false);
  assert.equal(isTimestampFresh("2026-11-25T00:00:00.001Z", t0), true);
  assert.equal(isTimestampFresh("2026-11-25T00:00:00.000Z", t0), false);

  assert.equal(isAccountExhaustedWithinTtl({ creditsRemaining: 0, balanceUpdatedAt: "2026-11-25T12:00:00.000Z" }, t0), true);
  assert.equal(isAccountExhaustedWithinTtl({ creditsRemaining: 0, balanceUpdatedAt: "2026-11-24T12:00:00.000Z" }, t0), false);
  assert.equal(isAccountExhaustedWithinTtl({ exhaustedMinCost: 15, exhaustedAt: "2026-11-25T12:00:00.000Z" }, t0), true);
  assert.equal(isAccountExhaustedWithinTtl({ exhaustedMinCost: 15, exhaustedAt: "2026-11-24T12:00:00.000Z" }, t0), false);

  const rec = (overrides: Record<string, unknown> = {}) => ({
    id: "b",
    slug: "b",
    label: "B",
    isDefault: false,
    enabled: true,
    priority: 2,
    needsRelogin: false,
    createdAt: "2026-11-25T00:00:00.000Z",
    updatedAt: "2026-11-25T00:00:00.000Z",
    ...overrides,
  });

  const attempted = new Set<string>(["done-id"]);
  assert.deepEqual(evaluateCandidateEligibility(rec({ id: "a" }), 15, attempted, "a", t0), {
    eligible: false,
    reason: "already_attempted",
  });
  assert.deepEqual(evaluateCandidateEligibility(rec({ id: "done-id" }), 15, attempted, "a", t0), {
    eligible: false,
    reason: "already_attempted",
  });
  assert.deepEqual(evaluateCandidateEligibility(rec({ enabled: false }), 15, attempted, "a", t0), {
    eligible: false,
    reason: "disabled",
  });
  assert.deepEqual(evaluateCandidateEligibility(rec({ needsRelogin: true }), 15, attempted, "a", t0), {
    eligible: false,
    reason: "needs_relogin",
  });
  assert.deepEqual(
    evaluateCandidateEligibility(rec({ creditsRemaining: 0, balanceUpdatedAt: "2026-11-25T23:00:00.000Z" }), 0, attempted, "a", t0),
    { eligible: false, reason: "insufficient_cached_credits" },
  );
  assert.deepEqual(
    evaluateCandidateEligibility(rec({ creditsRemaining: 10, balanceUpdatedAt: "2026-11-25T23:00:00.000Z" }), 15, attempted, "a", t0),
    { eligible: false, reason: "insufficient_cached_credits" },
  );
  // 10 credits remains eligible for 10-credit shot
  assert.deepEqual(
    evaluateCandidateEligibility(rec({ creditsRemaining: 10, balanceUpdatedAt: "2026-11-25T23:00:00.000Z" }), 10, attempted, "a", t0),
    { eligible: true },
  );
  // Stale 0 balance (>= 24h) is NOT pre-skipped
  assert.deepEqual(
    evaluateCandidateEligibility(rec({ creditsRemaining: 0, balanceUpdatedAt: "2026-11-25T00:00:00.000Z" }), 15, attempted, "a", t0),
    { eligible: true },
  );
  // Runtime exhaustion cost threshold within TTL
  assert.deepEqual(
    evaluateCandidateEligibility(rec({ exhaustedMinCost: 15, exhaustedAt: "2026-11-25T23:00:00.000Z" }), 15, attempted, "a", t0),
    { eligible: false, reason: "recently_exhausted" },
  );
  assert.deepEqual(
    evaluateCandidateEligibility(rec({ exhaustedMinCost: 15, exhaustedAt: "2026-11-25T23:00:00.000Z" }), 10, attempted, "a", t0),
    { eligible: true },
  );

  // Exhaustion patch & tightening
  assert.deepEqual(buildExhaustionPatch({}, { requiredCost: 15, creditsRemaining: 5, nowMs: t0 }), {
    creditsRemaining: 5,
    balanceUpdatedAt: "2026-11-26T00:00:00.000Z",
    exhaustedMinCost: null,
    exhaustedAt: null,
  });
  assert.deepEqual(buildExhaustionPatch({}, { requiredCost: 15, creditsRemaining: 20, nowMs: t0 }), {
    creditsRemaining: 20,
    balanceUpdatedAt: "2026-11-26T00:00:00.000Z",
    exhaustedMinCost: 15,
    exhaustedAt: "2026-11-26T00:00:00.000Z",
  });
  assert.deepEqual(buildExhaustionPatch({ exhaustedMinCost: 20, exhaustedAt: "2026-11-25T23:00:00.000Z" }, { requiredCost: 10, nowMs: t0 }), {
    exhaustedMinCost: 10,
    exhaustedAt: "2026-11-26T00:00:00.000Z",
  });
  assert.deepEqual(buildExhaustionPatch({}, { nowMs: t0 }), {
    exhaustedMinCost: 1,
    exhaustedAt: "2026-11-26T00:00:00.000Z",
  });

  // Flow sync patch
  assert.deepEqual(
    buildFlowSyncPatch({ url: "https://flow.google.com/project/11111111-1111-1111-1111-111111111111", signedIn: true, plan: "Pro", credits_remaining: 500 }, t0),
    {
      needsRelogin: false,
      lastProjectUrl: "https://flow.google.com/project/11111111-1111-1111-1111-111111111111",
      plan: "Pro",
      creditsRemaining: 500,
      exhaustedMinCost: null,
      exhaustedAt: null,
      balanceUpdatedAt: "2026-11-26T00:00:00.000Z",
    },
  );
  assert.deepEqual(buildFlowSyncPatch({ url: "https://flow.google.com/", connected: true, signedIn: true }, t0), {
    needsRelogin: false,
    lastProjectUrl: null,
  });
  assert.deepEqual(buildFlowSyncPatch({ url: "", connected: false, signedIn: false }, t0), {});

  // Error classification matrix
  assert.equal(classifyFailoverError(new AppError(503, ERROR_CODES.CHROME_NOT_FOUND, "missing")).kind, "host");
  assert.equal(classifyFailoverError(new AppError(503, ERROR_CODES.CDP_WRONG_PROFILE, "wrong")).kind, "host");
  assert.equal(classifyFailoverError(new TypeError("bad")).kind, "host");
  const auth = classifyFailoverError(new AppError(503, ERROR_CODES.AUTH_REQUIRED, "sign in"));
  assert.equal(auth.kind, "account");
  assert.equal(auth.markNeedsRelogin, true);
  assert.equal(classifyFailoverError(new AppError(503, ERROR_CODES.PROFILE_LOCKED, "locked")).markNeedsRelogin, false);
  assert.equal(classifyFailoverError(new Error("createProject timeout")).kind, "account");
  assert.equal(classifyFailoverError("plain string error").message, "plain string error");
  assert.equal(EXHAUSTION_TTL_MS, 86_400_000);
});

test("AccountStore + ChromeManager handle 24h TTL clock injection, pendingFailover crash recovery, selective CDP reclaim, and abort", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-failover-store-"));
  try {
    let nowMs = Date.parse("2026-11-26T00:00:00.000Z");
    const cfg = getConfig({ FLOW_MCP_HOME: join(root, "home"), FLOW_MCP_OUTPUT: join(root, "out"), FLOW_MCP_CDP_PORT: "9471" });
    mkdirSync(join(cfg.homeDir, "chrome-profile"), { recursive: true });

    const store = new AccountStore(cfg, undefined, () => nowMs);
    const b = store.addAccount("Backup 1");
    assert.equal(store.getAutoFailover(), true);
    assert.equal(store.setAutoFailover(false), false);
    assert.equal(store.setAutoFailover(true), true);
    assert.equal(store.revertPendingFailover(), null);

    store.updateMetadata(b.id, { creditsRemaining: 0, balanceUpdatedAt: new Date(nowMs).toISOString() });
    assert.equal(store.listAccounts().find((a) => a.id === b.id)?.exhausted, true);

    // Advance clock past 24h TTL -> exhausted flips to false automatically
    nowMs += EXHAUSTION_TTL_MS + 1000;
    assert.equal(store.listAccounts().find((a) => a.id === b.id)?.exhausted, false);

    // Simulate crash mid-failover with pendingFailover persisted on disk
    store.setPendingFailover({ originalAccountId: "default", candidateAccountId: b.id, startedAt: new Date(nowMs).toISOString() });
    store.setActive(b.id, null);

    const recovered = new AccountStore(cfg, undefined, () => nowMs);
    assert.equal(recovered.requireActiveAccount().id, "default");
    assert.equal(recovered.getPendingFailover(), null);
    const bPaths = recovered.getPaths(recovered.findAccount({ id: b.id }));
    assert.equal(recovered.getAbandonedCandidateProfileDir(), bPaths.profileDir);

    // Selective CDP 9333 reclaim: abandoned candidate profile reports offline on passive probe, reclaimed on connect
    const fake = makeFakeChrome({ getConfig: () => cfg, initialProfile: bPaths.profileDir });
    fake.chrome.setAbandonedProfileDir(recovered.getAbandonedCandidateProfileDir());
    const passive = await fake.chrome.probePassiveState(recovered.getActivePaths().profileDir);
    assert.equal(passive.connected, false);
    assert.equal(fake.isUp(), true);

    await fake.chrome.getFlowPage(recovered.getActivePaths().profileDir);
    assert.equal(fake.getActiveDir(), recovered.getActivePaths().profileDir);

    // Unrelated external profile STILL throws 503 CDP_WRONG_PROFILE
    const externalDir = join(root, "external-profile");
    await assert.rejects(
      () => fake.chrome.getFlowPage(externalDir),
      (err: AppError) => err.status === 503 && err.code === ERROR_CODES.CDP_WRONG_PROFILE,
    );

    // Also test revertPendingFailover when original account is disabled (pickFallbackAccountId) + corrupt store defaults
    const c = recovered.addAccount("Backup 2");
    recovered.setPendingFailover({ originalAccountId: "missing", candidateAccountId: c.id, startedAt: new Date(nowMs).toISOString() });
    assert.equal(recovered.revertPendingFailover()?.id, "default");

    writeFileSync(cfg.accountsFile, JSON.stringify({ ...JSON.parse(readFileSync(cfg.accountsFile, "utf8")), pendingFailover: { originalAccountId: "missing", candidateAccountId: "missing-cand", startedAt: "2026-11-26T00:00:00.000Z" } }));
    const fallbackStore = new AccountStore(cfg);
    assert.equal(fallbackStore.requireActiveAccount().id, "default");
    assert.equal(fallbackStore.getAbandonedCandidateProfileDir(), null);

    writeFileSync(cfg.accountsFile, "{bad");
    const corrupt = new AccountStore(cfg);
    assert.equal(corrupt.getAutoFailover(), true);
    assert.equal(corrupt.getPendingFailover(), null);

    // Launch abort on serialized close
    const abortChrome = new ChromeManager({
      getConfig: () => cfg,
      cdpProbe: async () => ({ ok: false, isCdp: false }),
      spawnChrome: () => 9999,
      isPidAlive: () => false,
      executable: () => "/usr/bin/chrome",
      sleep: async () => undefined,
      launchTimeoutMs: 500,
    });
    const launchP = abortChrome.getFlowPage(join(root, "abort-prof"));
    abortChrome.abortPendingLaunches();
    await assert.rejects(launchP, (err: AppError) => err.code === ERROR_CODES.CDP_UNAVAILABLE);
    await abortChrome.closeChromeSerialized();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AccountFailoverCoordinator orchestrates multi-hop failover, project recovery, chunk resume, bound blocks, and revert-to-A", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-failover-coord-"));
  try {
    let nowMs = Date.parse("2026-11-26T00:00:00.000Z");
    const cfg = getConfig({ FLOW_MCP_HOME: join(root, "home"), FLOW_MCP_OUTPUT: join(root, "out"), FLOW_MCP_CDP_PORT: "9472" });
    mkdirSync(join(cfg.homeDir, "chrome-profile"), { recursive: true });
    const store = new AccountStore(cfg, undefined, () => nowMs);
    const bDisabled = store.addAccount("B Disabled");
    store.enableAccount({ id: bDisabled.id }, false);
    const bAuth = store.addAccount("B AuthFail");
    store.updateMetadata(bAuth.id, { needsRelogin: false });
    const bLowLive = store.addAccount("B LowLive");
    store.updateMetadata(bLowLive.id, { needsRelogin: false });
    const bStaleUrl = store.addAccount("B CreateProjectFail");
    store.updateMetadata(bStaleUrl.id, { needsRelogin: false });
    const bRuntime = store.addAccount("B RuntimeCreditFail");
    store.updateMetadata(bRuntime.id, { needsRelogin: false });
    const cSuccess = store.addAccount("C Funded");
    store.updateMetadata(cSuccess.id, { needsRelogin: false, lastProjectUrl: "https://flow.google.com/project/stale" });

    const fake = makeFakeChrome({
      getConfig: () => cfg,
      initialProfile: store.getActivePaths().profileDir,
      initialUrl: "https://flow.google.com/project/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    });

    let activeStateFn: () => FlowState = () => ({ url: fake.chrome.switchInProgress ? "" : "https://flow.google.com/project/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", connected: true, signedIn: true, inProject: true, credits_remaining: 5 });
    let createProjectCount = 0;

    const flow = {
      getFlowState: async () => activeStateFn(),
      createProject: async () => {
        createProjectCount++;
        const id = store.requireActiveAccount().id;
        if (id === bStaleUrl.id) throw new Error("createProject timeout");
        const url = `https://flow.google.com/project/${createProjectCount}1111111-1111-1111-1111-111111111111`;
        fake.setUrl(url);
        return { id: `${createProjectCount}`, url, title: "Auto Created" };
      },
      listCharacters: async () => [],
    };

    const observedPhases: string[] = [];
    let svc!: AccountService;
    const queue = new JobQueue(
      (job) =>
        runQueuedJob(job, queue, {
          ...defaultCoreMediaDeps(),
          getConfig: () => cfg,
          extractLastFrame: async (clip) => `${clip}-lastframe.jpg`,
          runGeneration: async (j) => {
            const ownerId = store.requireActiveAccount().id;
            if (ownerId === "default") throw new CreditExhaustedError({ requiredCost: 15, creditsRemaining: 5, reason: "low credits" });
            if (ownerId === bRuntime.id) throw new CreditExhaustedError({ requiredCost: 15, reason: "runtime credit tile" });
            return [join(j.params.output_dir, `${j.params.file_stem}.mp4`)];
          },
          runAgentBatch: async (j, resume) => {
            const ownerId = store.requireActiveAccount().id;
            if (ownerId === "default") {
              j.params.agent_ref_assets = ["fm-old-ref"];
              resume!.done.add(0);
              resume!.files.push(join(j.params.output_dir, "scene-01.png"));
              throw new CreditExhaustedError({ requiredCost: 15, creditsRemaining: 0, reason: "chunk 2 exhausted" });
            }
            if (ownerId === cSuccess.id) {
              assert.equal(j.params.agent_ref_assets, undefined);
              assert.equal(resume!.done.has(0), true);
              resume!.done.add(1);
              resume!.files.push(join(j.params.output_dir, "scene-02.png"));
              return [...resume!.files];
            }
            throw new CreditExhaustedError({ reason: "unexpected" });
          },
          runEdit: async () => {
            throw new CreditExhaustedError({ creditsRemaining: 0, reason: "no credits for edit" });
          },
          runContinue: async () => [],
        }, (id) => svc.syncPostJobReadout(id), coord),
      () => ({ minMs: 0, maxMs: 0 }),
    );

    svc = new AccountService({ store, chrome: fake.chrome, queue, getConfig: () => cfg, flow });
    const coord = new AccountFailoverCoordinator({ store, chrome: fake.chrome, flow, hooks: svc.getInternalSwitchHooks() });
    svc.setFailoverPhaseProvider(() => coord.getPhase());

    // Configure getFlowState per candidate
    activeStateFn = () => {
      const id = store.requireActiveAccount().id;
      const phase = coord.getPhase();
      if (phase) observedPhases.push(phase.stage);
      if (id === bAuth.id) return { url: "https://accounts.google.com/", connected: true, signedIn: false, inProject: false, authInProgress: true };
      if (id === bLowLive.id) return { url: "https://flow.google.com/project/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", connected: true, signedIn: true, inProject: true, credits_remaining: 5 };
      if (id === bStaleUrl.id) return { url: "https://flow.google.com/", connected: true, signedIn: true, inProject: false };
      if (id === bRuntime.id) return { url: "https://flow.google.com/project/dddddddd-dddd-dddd-dddd-dddddddddddd", connected: true, signedIn: true, inProject: true };
      if (id === cSuccess.id) {
        const cur = fake.getActiveDir();
        assert.ok(cur.endsWith(store.getPaths(store.findAccount({ id: cSuccess.id })).profileDir));
        return fake.setUrl === undefined
          ? { url: "", connected: false, signedIn: false, inProject: false }
          : createProjectCount >= 2
          ? { url: "https://flow.google.com/project/21111111-1111-1111-1111-111111111111", connected: true, signedIn: true, inProject: true, credits_remaining: 900 }
          : { url: "https://flow.google.com/", connected: true, signedIn: true, inProject: false };
      }
      return { url: "https://flow.google.com/project/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", connected: true, signedIn: true, inProject: true, credits_remaining: 5 };
    };

    // 1. Account-bound job fails 409 ACCOUNT_BOUND_FAILOVER_BLOCKED without switching Chrome
    const boundEdit = queue.add({ prompt: "restyle", type: "video", max_credits: 0, edit_asset: "clip", output_dir: root, file_stem: "edit-01" }, { accountId: "default", accountLabel: "Primary" });
    for (let i = 0; i < 40 && boundEdit.status !== "failed"; i++) await new Promise((r) => setTimeout(r, 15));
    assert.equal(boundEdit.errorCode, ERROR_CODES.ACCOUNT_BOUND_FAILOVER_BLOCKED);
    assert.equal(store.requireActiveAccount().id, "default");

    // 2. Disabled autoFailover blocks portable failover -> 409 AUTO_FAILOVER_DISABLED
    svc.configureFailover(false);
    assert.deepEqual(svc.configureFailover(), { autoFailover: false });
    const disJob = queue.add({ prompt: "shot", type: "video", max_credits: 25, output_dir: root, file_stem: "scene-01" }, { accountId: "default", accountLabel: "Primary" });
    for (let i = 0; i < 40 && disJob.status !== "failed"; i++) await new Promise((r) => setTimeout(r, 15));
    assert.equal(disJob.errorCode, ERROR_CODES.AUTO_FAILOVER_DISABLED);
    svc.configureFailover(true);

    // 3. Multi-hop failover with mid-batch agent resume + queued portable adoption + queued bound mismatch
    const agentJob = queue.add(
      {
        prompt: "Agent",
        type: "image",
        max_credits: 0,
        agent_scenes: ["s1", "s2"],
        agent_refs: [{ image: "/tmp/local.png", name: "Ref" }],
        output_dir: root,
        file_stem: "scene-01",
      },
      { accountId: "default", accountLabel: "Primary" },
    );
    const queuedPortable = queue.add(
      { prompt: "ref from agent", type: "video", max_credits: 25, reference_from: agentJob.id, output_dir: root, file_stem: "scene-02" },
      { accountId: "default", accountLabel: "Primary" },
    );
    const queuedChained = queue.add(
      { prompt: "chain from ref", type: "video", max_credits: 25, chain_from: queuedPortable.id, output_dir: root, file_stem: "scene-03" },
      { accountId: "default", accountLabel: "Primary" },
    );
    const queuedBound = queue.add(
      { prompt: "bound", type: "video", max_credits: 25, first_frame: "asset:Hero", output_dir: root, file_stem: "scene-04" },
      { accountId: "default", accountLabel: "Primary" },
    );

    // Wait while failover/queue runs; verify getStatus short-circuits cleanly and mutations reject 409 while busy
    const stMid = await svc.getStatus(true);
    assert.equal(stMid.autoFailover, true);
    assert.throws(() => svc.enableAccount({ id: bDisabled.id }, true), (e: AppError) => e.code === ERROR_CODES.CHROME_BUSY || e.code === ERROR_CODES.SWITCH_IN_PROGRESS);
    assert.throws(() => svc.reorderAccounts([cSuccess.id, "default", bDisabled.id, bAuth.id, bLowLive.id, bStaleUrl.id, bRuntime.id]), AppError);
    assert.throws(() => svc.removeAccount({ id: bDisabled.id }), AppError);
    assert.throws(() => svc.configureFailover(false), AppError);

    for (let i = 0; i < 120 && (agentJob.status !== "done" || queuedPortable.status !== "done" || queuedChained.status !== "done" || queuedBound.status !== "failed"); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(agentJob.status, "done");
    assert.equal(agentJob.accountId, cSuccess.id);
    assert.deepEqual(agentJob.failoverFrom, { accountId: "default", accountLabel: "Primary" });
    assert.ok(agentJob.failoverAttempts?.some((a) => a.accountId === bAuth.id && a.status === "failed"));
    assert.ok(agentJob.failoverAttempts?.some((a) => a.accountId === cSuccess.id && a.status === "succeeded"));
    assert.equal(store.findAccount({ id: bAuth.id }).needsRelogin, true);
    assert.equal(store.requireActiveAccount().id, cSuccess.id);
    assert.ok(observedPhases.includes("verifying"));

    // Queued portable jobs adopted C without failoverFrom; queued bound job failed ACCOUNT_MISMATCH
    assert.equal(queuedPortable.status, "done");
    assert.equal(queuedPortable.accountId, cSuccess.id);
    assert.equal(queuedPortable.failoverFrom, undefined);
    assert.equal(queuedChained.status, "done");
    assert.equal(queuedChained.accountId, cSuccess.id);
    assert.equal(queuedChained.failoverFrom, undefined);
    assert.equal(queuedBound.status, "failed");
    assert.equal(queuedBound.errorCode, ERROR_CODES.ACCOUNT_MISMATCH);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AccountFailoverCoordinator covers host-wide abort, total exhaustion revert with partial agent files, and sole-account error", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-failover-revert-"));
  try {
    const cfg = getConfig({ FLOW_MCP_HOME: join(root, "home"), FLOW_MCP_OUTPUT: join(root, "out"), FLOW_MCP_CDP_PORT: "9473" });
    mkdirSync(join(cfg.homeDir, "chrome-profile"), { recursive: true });
    const store = new AccountStore(cfg);
    const fake = makeFakeChrome({ getConfig: () => cfg, initialProfile: store.getActivePaths().profileDir });
    const flow = {
      getFlowState: async () => ({ url: "https://flow.google.com/project/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", connected: true, signedIn: true, inProject: true }),
      createProject: async () => ({ id: "1", url: "https://flow.google.com/project/11111111-1111-1111-1111-111111111111", title: "P" }),
      listCharacters: async () => [],
    };
    const queue = new JobQueue(async () => [], () => ({ minMs: 0, maxMs: 0 }));
    const svc = new AccountService({ store, chrome: fake.chrome, queue, getConfig: () => cfg, flow });
    const coord = new AccountFailoverCoordinator({ store, chrome: fake.chrome, flow, hooks: svc.getInternalSwitchHooks() });

    // 1. Sole account -> 409 INSUFFICIENT_CREDITS
    const soleJob = queue.add({ prompt: "sole", type: "video", max_credits: 25, output_dir: root, file_stem: "s1" }, { accountId: "default", accountLabel: "Primary" });
    await assert.rejects(
      () =>
        coord.executeWithFailover(soleJob, async () => {
          throw new CreditExhaustedError({ requiredCost: 15, creditsRemaining: 0, reason: "empty" });
        }),
      (err: AppError) => err.status === 409 && err.code === ERROR_CODES.INSUFFICIENT_CREDITS,
    );

    // Bound job owned by another account without label falls back to accountId in ACCOUNT_MISMATCH
    const unlabeledBound = queue.add({ prompt: "bound", type: "video", max_credits: 25, first_frame: "asset:Hero", output_dir: root, file_stem: "s0" }, { accountId: "other-id" });
    assert.throws(() => coord.prepareQueuedJob(unlabeledBound), (err: AppError) => err.code === ERROR_CODES.ACCOUNT_MISMATCH && err.message.includes("other-id"));

    // 2. Add backup -> authInProgress triggers AUTH_REQUIRED -> all candidates exhausted -> revert to A (tolerating revert Chrome error) keeping partial agent files
    const backup = store.addAccount("Backup");
    store.updateMetadata(backup.id, { needsRelogin: false });
    const origSwitch = fake.chrome.switchProfile.bind(fake.chrome);
    fake.chrome.switchProfile = async (dir, startUrl) => {
      if (dir === store.getPaths(store.findAccount({ id: "default" })).profileDir) {
        throw new Error("revert chrome unavailable");
      }
      const res = await origSwitch(dir, startUrl);
      if (dir === store.getPaths(store.findAccount({ id: backup.id })).profileDir) {
        return { ...res, authInProgress: true };
      }
      return res;
    };

    const partialJob = queue.add(
      { prompt: "batch", type: "image", max_credits: 0, agent_scenes: ["a", "b"], output_dir: root, file_stem: "scene-01" },
      { accountId: "default", accountLabel: "Primary" },
    );
    await assert.rejects(
      () =>
        coord.executeWithFailover(partialJob, async (resume) => {
          resume!.done.add(0);
          resume!.files.push(join(root, "scene-01.png"));
          throw new CreditExhaustedError({ requiredCost: 10, creditsRemaining: 0, reason: "chunk 2 empty" });
        }),
      (err: AppError) => err.status === 409 && err.code === ERROR_CODES.FAILOVER_EXHAUSTED,
    );
    assert.equal(store.requireActiveAccount().id, "default");
    assert.equal(store.getPendingFailover(), null);
    assert.deepEqual(partialJob.files, [join(root, "scene-01.png")]);
    assert.deepEqual(partialJob.failed_scenes, [2]);

    // 3. Host-wide error on backup aborts immediately & reverts; non-credit error post-switch keeps partial files
    store.updateMetadata(backup.id, { needsRelogin: false });
    const b2 = store.addAccount("Backup 2");
    store.updateMetadata(b2.id, { needsRelogin: false });
    fake.chrome.switchProfile = async (dir, startUrl) => {
      if (dir === store.getPaths(store.findAccount({ id: backup.id })).profileDir) {
        throw new AppError(503, ERROR_CODES.CDP_PORT_OCCUPIED, "port conflict");
      }
      return origSwitch(dir, startUrl);
    };
    await assert.rejects(
      () =>
        coord.executeWithFailover(partialJob, async () => {
          throw new CreditExhaustedError({ requiredCost: 10, reason: "empty" });
        }),
      (err: AppError) => err.code === ERROR_CODES.CDP_PORT_OCCUPIED,
    );
    assert.equal(store.requireActiveAccount().id, "default");

    // 4. Non-credit error after switching to b2 retains b2 partial files, plus shutdown abort + revertPendingIfNeeded
    store.updateMetadata(backup.id, { needsRelogin: true });
    fake.chrome.switchProfile = async (dir, startUrl) => origSwitch(dir, startUrl);
    await assert.rejects(
      () =>
        coord.executeWithFailover(partialJob, async (resume) => {
          if (store.requireActiveAccount().id === "default") {
            throw new CreditExhaustedError({ requiredCost: 10, reason: "empty" });
          }
          resume!.done.add(0);
          resume!.files.push(join(root, "b2-scene-01.png"));
          throw new Error("policy refusal on b2");
        }),
      /policy refusal on b2/,
    );
    assert.deepEqual(partialJob.files, [join(root, "b2-scene-01.png")]);
    assert.deepEqual(partialJob.failed_scenes, [2]);

    // Shutdown abort cancels failover loop & reverts pendingFailover
    store.setActive("default", null);
    store.updateMetadata("default", { exhaustedMinCost: null, exhaustedAt: null });
    store.updateMetadata(b2.id, { exhaustedMinCost: null, exhaustedAt: null, creditsRemaining: undefined });
    const abortJob = queue.add({ prompt: "abort", type: "video", max_credits: 25, output_dir: root, file_stem: "s2" }, { accountId: "default", accountLabel: "Primary" });
    await assert.rejects(
      () =>
        coord.executeWithFailover(abortJob, async () => {
          coord.requestAbort();
          throw new CreditExhaustedError({ requiredCost: 10, reason: "empty" });
        }),
      (err: AppError) => err.code === ERROR_CODES.FAILOVER_EXHAUSTED,
    );
    store.setPendingFailover({ originalAccountId: "default", candidateAccountId: b2.id, startedAt: new Date().toISOString() });
    coord.revertPendingIfNeeded();
    assert.equal(store.getPendingFailover(), null);
    assert.equal(store.requireActiveAccount().id, "default");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("AccountService getStatus short-circuits during active switch and LocalCore wires idempotent chain/reference & shutdown", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-failover-svc-"));
  try {
    const cfg = getConfig({ FLOW_MCP_HOME: join(root, "home"), FLOW_MCP_OUTPUT: join(root, "out"), FLOW_MCP_CDP_PORT: "9474" });
    mkdirSync(join(cfg.homeDir, "chrome-profile"), { recursive: true });
    const fake = makeFakeChrome({ getConfig: () => cfg });
    let probeCalls = 0;
    const origProbe = fake.chrome.probePassiveState.bind(fake.chrome);
    fake.chrome.probePassiveState = async (dir) => {
      probeCalls++;
      return origProbe(dir);
    };

    const core = new LocalCore({
      getConfig: () => cfg,
      chrome: fake.chrome,
      flow: {
        getFlowState: async () => ({ url: "https://flow.google.com/project/11111111-1111-1111-1111-111111111111", connected: true, signedIn: true, inProject: true }),
        createProject: async () => ({ id: "1", url: "https://flow.google.com/project/11111111-1111-1111-1111-111111111111", title: "P" }),
        listCharacters: async () => [],
      },
    });
    assert.deepEqual(await core.account_config({}), { autoFailover: true });
    assert.deepEqual(await core.account_config({ auto_failover: false }), { autoFailover: false });

    const hooks = core.accountService.getInternalSwitchHooks();
    hooks.beginSwitch();
    const st = await core.status({ detailed: true });
    assert.equal(st.switchInProgress, true);
    assert.equal(probeCalls, 0);
    hooks.endSwitch();

    // Idempotent reference_from / chain_from via runQueuedJob
    const q = new JobQueue(async () => [], () => ({ minMs: 0, maxMs: 0 }));
    const prevImg = q.add({ prompt: "img", type: "image", max_credits: 0, output_dir: root, file_stem: "s1" });
    prevImg.status = "done";
    prevImg.files = [join(root, "still.png")];
    const refJob = q.add({ prompt: "use", type: "image", max_credits: 0, reference_from: prevImg.id, reference_images: [join(root, "still.png")], output_dir: root, file_stem: "s2" });
    await runQueuedJob(
      refJob,
      q,
      { ...defaultCoreMediaDeps(), runGeneration: async (j) => j.params.reference_images ?? [] },
      async () => undefined,
    );
    assert.deepEqual(refJob.params.reference_images, [join(root, "still.png")]);

    await core.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("syncPartialAgentState preserves partial Chunk 1 files on all pre-revert throw paths and runQueuedJob skips syncReadout on credit exhaustion", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-failover-partial-sync-"));
  try {
    const cfg = getConfig({ FLOW_MCP_HOME: join(root, "home"), FLOW_MCP_OUTPUT: join(root, "out"), FLOW_MCP_CDP_PORT: "9475" });
    mkdirSync(join(cfg.homeDir, "chrome-profile"), { recursive: true });
    const store = new AccountStore(cfg);
    const fake = makeFakeChrome({ getConfig: () => cfg, initialProfile: store.getActivePaths().profileDir });
    const flow = {
      getFlowState: async () => ({ url: "https://flow.google.com/project/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", connected: true, signedIn: true, inProject: true, credits_remaining: 20 }),
      createProject: async () => ({ id: "1", url: "https://flow.google.com/project/11111111-1111-1111-1111-111111111111", title: "P" }),
      listCharacters: async () => [],
    };
    const queue = new JobQueue(async () => [], () => ({ minMs: 0, maxMs: 0 }));
    const svc = new AccountService({ store, chrome: fake.chrome, queue, getConfig: () => cfg, flow });
    const coord = new AccountFailoverCoordinator({ store, chrome: fake.chrome, flow, hooks: svc.getInternalSwitchHooks() });

    const chunk1File = join(root, "scene-01.png");

    // 1a. Non-credit AppError on starting account A (!chromeSwitched) preserves partial files & remaining scenes
    const nonCreditStartJob = queue.add(
      { prompt: "agent", type: "image", max_credits: 0, agent_scenes: ["s1", "s2"], output_dir: root, file_stem: "scene-01" },
      { accountId: "default", accountLabel: "Primary" },
    );
    await assert.rejects(
      () =>
        coord.executeWithFailover(nonCreditStartJob, async (resume) => {
          resume!.done.add(0);
          resume!.files.push(chunk1File);
          throw new AppError(503, ERROR_CODES.AUTH_REQUIRED, "session expired mid-batch");
        }),
      (err: AppError) => err.code === ERROR_CODES.AUTH_REQUIRED,
    );
    assert.deepEqual(nonCreditStartJob.files, [chunk1File]);
    assert.deepEqual(nonCreditStartJob.failed_scenes, [2]);

    // 1b. Sole account CreditExhaustedError after Chunk 1 preserves partial files & remaining scenes
    const solePartialJob = queue.add(
      { prompt: "agent", type: "image", max_credits: 0, agent_scenes: ["s1", "s2"], output_dir: root, file_stem: "scene-01" },
      { accountId: "default", accountLabel: "Primary" },
    );
    await assert.rejects(
      () =>
        coord.executeWithFailover(solePartialJob, async (resume) => {
          resume!.done.add(0);
          resume!.files.push(chunk1File);
          throw new CreditExhaustedError({ requiredCost: 15, creditsRemaining: 20, reason: "quota exhausted" });
        }),
      (err: AppError) => err.code === ERROR_CODES.INSUFFICIENT_CREDITS,
    );
    assert.deepEqual(solePartialJob.files, [chunk1File]);
    assert.deepEqual(solePartialJob.failed_scenes, [2]);

    // 1c. !job.portable after Chunk 1 (even with backup account) preserves partial files & remaining scenes
    const backup = store.addAccount("Backup");
    store.updateMetadata(backup.id, { needsRelogin: false });
    store.updateMetadata("default", { exhaustedMinCost: null, exhaustedAt: null });
    const boundPartialJob = queue.add(
      {
        prompt: "agent",
        type: "image",
        max_credits: 0,
        agent_scenes: ["s1", "s2"],
        agent_refs: [{ image: "asset:Hero", name: "Hero" }],
        output_dir: root,
        file_stem: "scene-01",
      },
      { accountId: "default", accountLabel: "Primary" },
    );
    await assert.rejects(
      () =>
        coord.executeWithFailover(boundPartialJob, async (resume) => {
          resume!.done.add(0);
          resume!.files.push(chunk1File);
          throw new CreditExhaustedError({ requiredCost: 15, creditsRemaining: 20, reason: "quota exhausted" });
        }),
      (err: AppError) => err.code === ERROR_CODES.ACCOUNT_BOUND_FAILOVER_BLOCKED,
    );
    assert.deepEqual(boundPartialJob.files, [chunk1File]);
    assert.deepEqual(boundPartialJob.failed_scenes, [2]);

    // 1d. !autoFailover after Chunk 1 preserves partial files & remaining scenes
    store.setAutoFailover(false);
    store.updateMetadata("default", { exhaustedMinCost: null, exhaustedAt: null });
    const disabledPartialJob = queue.add(
      { prompt: "agent", type: "image", max_credits: 0, agent_scenes: ["s1", "s2"], output_dir: root, file_stem: "scene-01" },
      { accountId: "default", accountLabel: "Primary" },
    );
    await assert.rejects(
      () =>
        coord.executeWithFailover(disabledPartialJob, async (resume) => {
          resume!.done.add(0);
          resume!.files.push(chunk1File);
          throw new CreditExhaustedError({ requiredCost: 15, creditsRemaining: 20, reason: "quota exhausted" });
        }),
      (err: AppError) => err.code === ERROR_CODES.AUTO_FAILOVER_DISABLED,
    );
    assert.deepEqual(disabledPartialJob.files, [chunk1File]);
    assert.deepEqual(disabledPartialJob.failed_scenes, [2]);

    // 2. runQueuedJob skips syncReadout on credit exhaustion (keeping exhaustedMinCost & exhaustedAt intact) and runs it on normal/non-credit paths
    let syncCalls = 0;
    const trackedSync = async (id: string) => {
      syncCalls++;
      await svc.syncPostJobReadout(id);
    };

    // 2a. Credit exhaustion with failover (AUTO_FAILOVER_DISABLED) keeps exhaustedMinCost=15 & exhaustedAt intact
    const qJobDisabled = queue.add(
      { prompt: "shot", type: "video", max_credits: 25, output_dir: root, file_stem: "q1" },
      { accountId: "default", accountLabel: "Primary" },
    );
    await assert.rejects(
      () =>
        runQueuedJob(
          qJobDisabled,
          queue,
          {
            ...defaultCoreMediaDeps(),
            runGeneration: async () => {
              throw new CreditExhaustedError({ requiredCost: 15, creditsRemaining: 20, reason: "quota cap" });
            },
          },
          trackedSync,
          coord,
        ),
      (err: AppError) => err.code === ERROR_CODES.AUTO_FAILOVER_DISABLED,
    );
    assert.equal(syncCalls, 0);
    const afterQuota = store.findAccount({ id: "default" });
    assert.equal(afterQuota.exhaustedMinCost, 15);
    assert.ok(afterQuota.exhaustedAt);

    // 2b. Direct CreditExhaustedError without failover also skips syncReadout
    await assert.rejects(
      () =>
        runQueuedJob(
          qJobDisabled,
          queue,
          {
            ...defaultCoreMediaDeps(),
            runGeneration: async () => {
              throw new CreditExhaustedError({ requiredCost: 15, creditsRemaining: 20, reason: "direct" });
            },
          },
          trackedSync,
        ),
      (err: unknown) => err instanceof CreditExhaustedError,
    );
    assert.equal(syncCalls, 0);

    // 2c. Non-credit AppError (MAX_CREDITS_EXCEEDED) & generic Error still run syncReadout
    await assert.rejects(
      () =>
        runQueuedJob(
          qJobDisabled,
          queue,
          {
            ...defaultCoreMediaDeps(),
            runGeneration: async () => {
              throw new AppError(400, ERROR_CODES.MAX_CREDITS_EXCEEDED, "over cap");
            },
          },
          trackedSync,
          coord,
        ),
      (err: AppError) => err.code === ERROR_CODES.MAX_CREDITS_EXCEEDED,
    );
    assert.equal(syncCalls, 1);

    await assert.rejects(
      () =>
        runQueuedJob(
          qJobDisabled,
          queue,
          {
            ...defaultCoreMediaDeps(),
            runGeneration: async () => {
              throw new Error("network timeout");
            },
          },
          trackedSync,
          coord,
        ),
      /network timeout/,
    );
    assert.equal(syncCalls, 2);

    // 2d. Normal success runs syncReadout
    const outFiles = await runQueuedJob(
      qJobDisabled,
      queue,
      {
        ...defaultCoreMediaDeps(),
        runGeneration: async () => [join(root, "ok.mp4")],
      },
      trackedSync,
      coord,
    );
    assert.deepEqual(outFiles, [join(root, "ok.mp4")]);
    assert.equal(syncCalls, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
