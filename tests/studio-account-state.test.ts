import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ERROR_CODES } from "../dist/errors.js";
import {
  ACCOUNT_CONSTANTS,
  createTranslator,
  deriveAccountsViewState,
  deriveHeaderStatus,
  deriveJobRetryState,
  deriveRowControls,
  detectAccountChange,
  extractErrorInfo,
  flattenLocale,
  formatUtcTimestamp,
  isAbortError,
  resetStaleStudioState,
  shouldPollDetailed,
  validateAccountLabelInput,
  type AccountItem,
  type FlowStatusInfo,
  type StudioJobView,
  type StudioStatusPayload,
} from "../dist/studio/account-state.js";

function loadEnTranslator() {
  const raw = JSON.parse(readFileSync(join(process.cwd(), "src/locales/en.json"), "utf8")) as unknown;
  const catalog = flattenLocale(raw);
  return { catalog, t: createTranslator(catalog) };
}

function makeAccount(overrides: Partial<AccountItem> = {}): AccountItem {
  return {
    id: "default",
    slug: "default",
    label: "Primary",
    isDefault: true,
    enabled: true,
    priority: 1,
    active: true,
    needsRelogin: false,
    ...overrides,
  };
}

function makeFlow(overrides: Partial<FlowStatusInfo> = {}): FlowStatusInfo {
  return {
    url: "https://flow.google.com/project/11111111-1111-1111-1111-111111111111",
    connected: true,
    signedIn: true,
    inProject: true,
    authInProgress: false,
    ...overrides,
  };
}

function makeStatus(overrides: Partial<StudioStatusPayload> = {}): StudioStatusPayload {
  const primary = makeAccount();
  return {
    flow: makeFlow(),
    activeAccount: primary,
    activeAccountId: primary.id,
    accounts: [primary],
    pendingLogin: null,
    registryError: null,
    busy: false,
    switchInProgress: false,
    jobs: [],
    ...overrides,
  };
}

test("locale flattening, translator, error extraction, abort check, and timestamp formatting", () => {
  const { catalog, t } = loadEnTranslator();
  assert.ok(Object.keys(catalog).length > 50);
  assert.deepEqual(flattenLocale(null), {});
  assert.deepEqual(flattenLocale(["a"]), {});
  assert.equal(t("missing.key"), "missing.key");
  assert.equal(t("account.header.pillLabel", { label: "Work" }), "Account: Work");

  const abortErr = new Error("aborted");
  abortErr.name = "AbortError";
  assert.equal(isAbortError(abortErr), true);
  assert.equal(isAbortError(new Error("boom")), false);
  assert.equal(isAbortError("aborted"), false);

  assert.deepEqual(extractErrorInfo({ code: "CHROME_BUSY", message: "Busy" }, t), { message: "Busy", code: "CHROME_BUSY" });
  assert.deepEqual(extractErrorInfo({ code: "CHROME_BUSY" }, t), { message: catalog["error.CHROME_BUSY"], code: "CHROME_BUSY" });
  assert.deepEqual(extractErrorInfo("plain string", t), { message: "plain string", code: null });
  assert.deepEqual(extractErrorInfo({}, t), { message: catalog["error.INTERNAL_ERROR"], code: null });
  assert.deepEqual(extractErrorInfo(42, t), { message: catalog["error.INTERNAL_ERROR"], code: null });

  assert.equal(formatUtcTimestamp(undefined, "en-US"), null);
  assert.equal(formatUtcTimestamp("not-a-date", "en-US"), "not-a-date");
  const formatted = formatUtcTimestamp("2026-11-25T15:30:00.000Z", "en-US");
  assert.ok(formatted && formatted.length > 4);
});

test("validateAccountLabelInput bridges shared validation rules to account.form.* locale strings", () => {
  const { catalog, t } = loadEnTranslator();
  assert.equal(ACCOUNT_CONSTANTS.LABEL_MAX, 60);

  const ok = validateAccountLabelInput("  Backup 1  ", ["Primary"], t);
  assert.deepEqual(ok, { ok: true, label: "Backup 1", length: 8 });

  const empty = validateAccountLabelInput("   ", ["Primary"], t);
  assert.deepEqual(empty, { ok: false, message: catalog["account.form.errorEmpty"], length: 0 });

  const tooLong = validateAccountLabelInput("a".repeat(61), ["Primary"], t);
  assert.deepEqual(tooLong, { ok: false, message: t("account.form.errorTooLong", { max: 60 }), length: 61 });

  const dup = validateAccountLabelInput("primary", ["Primary"], t);
  assert.deepEqual(dup, { ok: false, message: t("account.form.errorDuplicate", { label: "primary" }), length: 7 });

  const ctrl = validateAccountLabelInput("bad\u0007name", ["Primary"], t);
  assert.deepEqual(ctrl, { ok: false, message: catalog["error.LABEL_CONTROL_CHARS"], length: 8 });
});

test("deriveAccountsViewState resolves all 6 discriminated states and active fallback branches", () => {
  const { t } = loadEnTranslator();
  const base = {
    loading: false,
    accounts: [makeAccount()],
    activeAccountId: "default",
    pendingLogin: null,
    registryError: null,
    loadError: null,
    switchInProgress: false,
    authInProgress: false,
    switchingTargetId: null,
  };

  assert.equal(deriveAccountsViewState({ ...base, loading: true }, t).kind, "loading");
  assert.equal(deriveAccountsViewState({ ...base, registryError: "corrupt" }, t).kind, "error");
  assert.equal(
    deriveAccountsViewState({ ...base, accounts: [], loadError: { message: "net", code: "REMOTE_UNREACHABLE" } }, t).kind,
    "error",
  );
  assert.equal(deriveAccountsViewState({ ...base, accounts: [], activeAccountId: null }, t).kind, "error");
  assert.equal(deriveAccountsViewState({ ...base, accounts: [], activeAccountId: "x" }, t).kind, "error");

  const second = makeAccount({ id: "b1", slug: "b1", label: "Backup 1", isDefault: false, active: false, priority: 2 });
  const twoInactiveFlag = [makeAccount({ active: false }), second];
  const byId = deriveAccountsViewState({ ...base, accounts: twoInactiveFlag, activeAccountId: "b1" }, t);
  assert.equal(byId.kind, "populated");
  if (byId.kind === "populated") assert.equal(byId.activeAccount.id, "b1");

  const fallbackFirst = deriveAccountsViewState({ ...base, accounts: [makeAccount({ active: false })], activeAccountId: "missing" }, t);
  assert.equal(fallbackFirst.kind, "empty");

  assert.equal(deriveAccountsViewState({ ...base, switchInProgress: true }, t).kind, "switching");
  assert.equal(deriveAccountsViewState({ ...base, switchingTargetId: "b1" }, t).kind, "switching");
  const failoverSwitch = deriveAccountsViewState(
    {
      ...base,
      accounts: [makeAccount(), second],
      failoverPhase: { stage: "switching", fromAccountId: "default", fromLabel: "Primary", toAccountId: "b1", toLabel: "Backup 1", startedAt: "now" },
    },
    t,
  );
  assert.equal(failoverSwitch.kind, "switching");
  if (failoverSwitch.kind === "switching") assert.equal(failoverSwitch.targetId, "b1");
  assert.equal(deriveAccountsViewState({ ...base, authInProgress: true }, t).kind, "authInProgress");
  assert.equal(
    deriveAccountsViewState(
      { ...base, pendingLogin: { targetAccountId: "default", previousAccountId: "b1", startedAt: "2026-01-01T00:00:00Z" } },
      t,
    ).kind,
    "authInProgress",
  );
  assert.equal(deriveAccountsViewState(base, t).kind, "empty");
  assert.equal(deriveAccountsViewState({ ...base, accounts: [makeAccount(), { ...second, enabled: false }] }, t).kind, "empty");
  assert.equal(deriveAccountsViewState({ ...base, accounts: [makeAccount(), second] }, t).kind, "populated");
});

test("deriveHeaderStatus, deriveRowControls, deriveJobRetryState, detectAccountChange, and shouldPollDetailed", () => {
  const { t } = loadEnTranslator();
  const offlineNotConn = deriveHeaderStatus(
    { live: false, offline: false, loading: false, status: null, plan: undefined, credits: undefined, switching: false },
    t,
  );
  assert.equal(offlineNotConn.statusText, t("account.header.statusNotConnected"));
  assert.equal(offlineNotConn.tallyClass, "down");

  const offlineDown = deriveHeaderStatus(
    { live: true, offline: true, loading: false, status: null, plan: undefined, credits: undefined, switching: false },
    t,
  );
  assert.equal(offlineDown.statusText, t("account.header.statusOffline"));
  assert.equal(offlineDown.tallyClass, "down");

  const connecting = deriveHeaderStatus(
    { live: true, offline: false, loading: true, status: null, plan: undefined, credits: undefined, switching: false },
    t,
  );
  assert.equal(connecting.statusText, t("account.header.statusConnecting"));
  assert.equal(connecting.tallyClass, "dim");
  const signedOut = deriveHeaderStatus(
    {
      live: true,
      offline: false,
      loading: false,
      status: makeStatus({ flow: makeFlow({ signedIn: false, inProject: false }) }),
      plan: undefined,
      credits: undefined,
      switching: false,
    },
    t,
  );
  assert.equal(signedOut.statusText, t("account.header.statusSignedOut"));
  assert.equal(signedOut.showNewProjectBtn, false);

  const noProj = deriveHeaderStatus(
    {
      live: true,
      offline: false,
      loading: false,
      status: makeStatus({ flow: makeFlow({ signedIn: true, inProject: false }) }),
      plan: "Pro",
      credits: 250,
      switching: false,
    },
    t,
  );
  assert.equal(noProj.statusText, t("account.header.statusNoProject"));
  assert.equal(noProj.showNewProjectBtn, true);
  assert.equal(noProj.hintText, t("hint.noProject"));

  const working = deriveHeaderStatus(
    {
      live: true,
      offline: false,
      loading: false,
      status: makeStatus({ jobs: [{ id: "j1", status: "running" }], flow: makeFlow({ hint: "custom" }) }),
      plan: "Pro",
      credits: 100,
      switching: false,
    },
    t,
  );
  assert.equal(working.tallyClass, "rolling");
  assert.equal(working.hintText, "custom");

  const queued = deriveHeaderStatus(
    {
      live: true,
      offline: false,
      loading: false,
      status: makeStatus({
        activeAccount: makeAccount({ needsRelogin: true }),
        jobs: [{ id: "j2", status: "queued" }],
      }),
      plan: undefined,
      credits: undefined,
      switching: false,
    },
    t,
  );
  assert.equal(queued.pillTone, "warn");

  const ready = deriveHeaderStatus(
    { live: true, offline: false, loading: false, status: makeStatus(), plan: undefined, credits: undefined, switching: false },
    t,
  );
  assert.equal(ready.tallyClass, "ready");
  assert.equal(ready.pillTone, "ready");

  const corrupt = deriveHeaderStatus(
    {
      live: true,
      offline: false,
      loading: false,
      status: makeStatus({ registryError: "bad", activeAccount: null, activeAccountId: null }),
      plan: undefined,
      credits: undefined,
      switching: false,
    },
    t,
  );
  assert.equal(corrupt.pillTone, "down");
  assert.equal(corrupt.hintText, t("hint.registryCorrupt"));

  const switching = deriveHeaderStatus(
    { live: true, offline: false, loading: false, status: makeStatus({ switchInProgress: true }), plan: undefined, credits: undefined, switching: true },
    t,
  );
  assert.equal(switching.pillTone, "rolling");
  assert.equal(switching.hintText, t("hint.switchInProgress"));

  const failoverHead = deriveHeaderStatus(
    {
      live: true,
      offline: false,
      loading: false,
      status: makeStatus({
        flow: makeFlow({ signedIn: true, inProject: false }),
        switchInProgress: false,
        failoverPhase: { stage: "verifying", fromAccountId: "default", fromLabel: "Primary", toAccountId: "b1", toLabel: "Backup 1", startedAt: "now" },
      }),
      plan: undefined,
      credits: undefined,
      switching: false,
    },
    t,
  );
  assert.equal(failoverHead.pillTone, "rolling");
  assert.equal(failoverHead.pillText, t("account.failover.pillVerifying", { toLabel: "Backup 1" }));
  assert.equal(failoverHead.showNewProjectBtn, false);
  assert.ok(failoverHead.hintText?.includes("Backup 1"));

  const authHead = deriveHeaderStatus(
    {
      live: true,
      offline: false,
      loading: false,
      status: makeStatus({ flow: makeFlow({ signedIn: false, inProject: false, authInProgress: true }) }),
      plan: undefined,
      credits: undefined,
      switching: false,
    },
    t,
  );
  assert.equal(authHead.pillTone, "warn");

  // Row controls coverage across active, disabled, busy, sole, first/middle/last
  const activeCtrl = deriveRowControls(makeAccount(), 0, 1, 1, false, t);
  assert.equal(activeCtrl.switchDisabled, true);
  assert.equal(activeCtrl.enableDisabled, true);
  assert.equal(activeCtrl.removeDisabled, true);
  assert.equal(activeCtrl.moveUpDisabled, true);
  assert.equal(activeCtrl.moveDownDisabled, true);
  assert.equal(activeCtrl.refreshDisabled, false);
  assert.equal(activeCtrl.newProjectDisabled, false);

  const inactiveDisabled = makeAccount({ id: "b1", isDefault: false, active: false, enabled: false, priority: 2 });
  const disabledCtrl = deriveRowControls(inactiveDisabled, 1, 3, 1, false, t);
  assert.equal(disabledCtrl.switchReason?.text, t("account.disabled.disabledSwitch"));
  assert.equal(disabledCtrl.refreshReason?.text, t("account.disabled.inactiveRefresh"));
  assert.equal(disabledCtrl.newProjectReason?.text, t("account.disabled.inactiveNewProject"));
  assert.equal(disabledCtrl.enableDisabled, false);
  assert.equal(disabledCtrl.removeDisabled, false);
  assert.equal(disabledCtrl.loginDisabled, true);

  const inactiveBusy = makeAccount({ id: "b2", isDefault: false, active: false, enabled: true, priority: 2 });
  const busyCtrl = deriveRowControls(inactiveBusy, 1, 3, 2, true, t);
  assert.equal(busyCtrl.switchReason?.text, t("account.disabled.busySwitch"));
  assert.equal(busyCtrl.enableReason?.text, t("account.disabled.busySwitch"));
  assert.equal(busyCtrl.refreshReason?.text, t("account.disabled.inactiveRefresh"));
  assert.equal(busyCtrl.newProjectReason?.text, t("account.disabled.inactiveNewProject"));
  assert.equal(busyCtrl.moveUpReason?.text, t("account.disabled.busySwitch"));
  assert.equal(busyCtrl.moveDownReason?.text, t("account.disabled.busySwitch"));
  assert.equal(busyCtrl.removeReason?.text, t("account.disabled.busySwitch"));

  const activeBusy = deriveRowControls(makeAccount({ active: true }), 1, 3, 2, true, t);
  assert.equal(activeBusy.refreshReason?.text, t("account.disabled.busySwitch"));
  assert.equal(activeBusy.newProjectReason?.text, t("account.disabled.busySwitch"));

  const soleDisabledCheck = deriveRowControls(makeAccount({ active: false, enabled: true }), 0, 1, 1, false, t);
  assert.equal(soleDisabledCheck.enableReason?.text, t("account.disabled.soleEnabled"));

  // Job retry guard
  const jCross: StudioJobView = { id: "j1", status: "failed", accountId: "a", accountLabel: "Account A", portable: false };
  assert.equal(deriveJobRetryState(jCross, "b", "Account B").blocked, true);
  assert.equal(deriveJobRetryState(jCross, "b", "Account B").portableCrossAccount, false);
  const jPortableCross: StudioJobView = { id: "j1p", status: "failed", accountId: "a", accountLabel: "Account A", portable: true };
  assert.equal(deriveJobRetryState(jPortableCross, "b", "Account B").blocked, false);
  assert.equal(deriveJobRetryState(jPortableCross, "b", "Account B").portableCrossAccount, true);
  assert.equal(deriveJobRetryState({ id: "j2", status: "cancelled", accountId: "a" }, "b", null).jobAccount, "a");
  assert.equal(deriveJobRetryState({ id: "j3", status: "done", failed_scenes: [1], accountId: "a" }, null, null).jobAccount, "a");
  assert.equal(deriveJobRetryState({ id: "j4", status: "done" }, "a", "A").isRetryable, false);
  assert.equal(deriveJobRetryState({ id: "j5", status: "failed" }, null, null).activeAccount, "");

  // Account change + revert detection
  const a1 = makeAccount({ id: "a", label: "A" });
  const a2 = makeAccount({ id: "b", label: "B", active: false, isDefault: false });
  assert.deepEqual(
    detectAccountChange({ sessionAccountId: null, persistedAccountId: null, nextAccountId: null, prevPending: null, nextPending: null, accounts: [a1] }),
    { changed: false, revertedLabel: null },
  );
  assert.deepEqual(
    detectAccountChange({ sessionAccountId: null, persistedAccountId: "a", nextAccountId: "b", prevPending: null, nextPending: null, accounts: [a1, a2] }),
    { changed: true, revertedLabel: null },
  );
  assert.deepEqual(
    detectAccountChange({
      sessionAccountId: "b",
      persistedAccountId: "b",
      nextAccountId: "a",
      prevPending: { targetAccountId: "b", previousAccountId: "a", startedAt: "now" },
      nextPending: null,
      accounts: [a1, a2],
    }),
    { changed: true, revertedLabel: "A" },
  );
  assert.deepEqual(
    detectAccountChange({
      sessionAccountId: "b",
      persistedAccountId: "b",
      nextAccountId: "c",
      prevPending: { targetAccountId: "b", previousAccountId: "c", startedAt: "now" },
      nextPending: null,
      accounts: [a1, a2],
    }),
    { changed: true, revertedLabel: null },
  );

  // One-shot detailed poll
  assert.equal(shouldPollDetailed(null, makeFlow(), true), false);
  assert.equal(shouldPollDetailed(null, makeFlow({ signedIn: false }), false), false);
  assert.equal(shouldPollDetailed(null, makeFlow({ signedIn: true, inProject: false }), false), true);
  assert.equal(shouldPollDetailed(makeFlow({ signedIn: false, inProject: false }), makeFlow({ signedIn: true, inProject: false }), false), true);
  assert.equal(shouldPollDetailed(makeFlow({ signedIn: true, inProject: false }), makeFlow({ signedIn: true, inProject: true }), false), true);
  assert.equal(shouldPollDetailed(makeFlow({ signedIn: true, inProject: true }), makeFlow({ signedIn: true, inProject: true }), false), false);
});

test("resetStaleStudioState preserves and tags asset refs non-destructively and verifies HTML/locale invariants", () => {
  const calls: string[] = [];
  const state = {
    frames: {
      scenes: [
        { first: { asset: "Hero" }, last: { path: "/tmp/keep.png" }, refs: [{ asset: "Hero" }, { path: "/tmp/ref.png" }] },
        { first: null, last: { asset: "Villain" }, refs: [] },
      ],
    },
    shots: {
      scenes: [{ first: { path: "/tmp/start.png" }, last: null, refs: [{ asset: "Villain" }] }],
    },
  };
  const castImg = { asset: "Lead" };
  const preserved = resetStaleStudioState(
    {
      getStudioState: () => state,
      getCastImage: () => castImg,
      saveStudioState: () => calls.push("save"),
      clearLib: () => calls.push("lib"),
      clearAssetPickers: () => calls.push("pick"),
      clearCast: () => calls.push("cast"),
      renderAll: () => calls.push("render"),
    },
    { id: "a1", label: "Primary" },
  );
  assert.deepEqual(calls, ["lib", "pick", "cast", "save", "render"]);
  assert.equal(preserved.preservedAssets, 5);
  assert.deepEqual(state.frames.scenes[0].first, { asset: "Hero", assetAccountId: "a1", assetAccountLabel: "Primary" });
  assert.deepEqual(state.frames.scenes[0].last, { path: "/tmp/keep.png" });
  assert.deepEqual(state.frames.scenes[0].refs[0], { asset: "Hero", assetAccountId: "a1", assetAccountLabel: "Primary" });
  assert.deepEqual(state.frames.scenes[0].refs[1], { path: "/tmp/ref.png" });
  assert.deepEqual(state.frames.scenes[1].last, { asset: "Villain", assetAccountId: "a1", assetAccountLabel: "Primary" });
  assert.deepEqual(state.shots.scenes[0].first, { path: "/tmp/start.png" });
  assert.deepEqual(state.shots.scenes[0].refs, [{ asset: "Villain", assetAccountId: "a1", assetAccountLabel: "Primary" }]);
  assert.deepEqual(castImg, { asset: "Lead", assetAccountId: "a1", assetAccountLabel: "Primary" });

  // Omitted prevAccount leaves unknown-origin untagged
  const legacyRes = resetStaleStudioState({
    getStudioState: () => ({ frames: { scenes: [{ first: { asset: "Old" }, last: null, refs: [] }] }, shots: { scenes: [] } }),
    getCastImage: () => null,
    saveStudioState: () => {},
    clearLib: () => {},
    clearAssetPickers: () => {},
    clearCast: () => {},
    renderAll: () => {},
  });
  assert.equal(legacyRes.preservedAssets, 1);

  // Verify studio/index.html wires tokens, touch-target specificity, non-scaling dialog animation, failover row, draft banners, and locale invariants
  const html = readFileSync(join(process.cwd(), "studio/index.html"), "utf8");
  for (const needle of [
    'id="accountsDialog"',
    'id="accountTrashDialog"',
    'id="newProjectDialog"',
    'id="accFailoverRow"',
    'id="accFailoverToggle"',
    'id="f_mismatch"',
    'id="s_mismatch"',
    'id="cast_mismatch"',
    "/studio/account-ui.js",
    "--line-ui",
    "--ease-out-expo",
    "--acc-slot-clear-pad",
    "--acc-switch-w",
    ".slot.is-populated",
    ".slot.is-mismatch",
    ".acc-draft-banner",
    ".acc-failover-strip",
    ".cols{display:grid;grid-template-columns:minmax(0,1fr)",
    ".cols>*,.panel,.side{min-width:0}",
    ".empty,#galInfo,.card p{overflow-wrap:anywhere;word-break:break-word}",
    ".btn.small.acc-close-btn",
    ".acc-actions>.btn.small",
    ".acc-hint-box>.btn.small",
    ".job .top>.btn.small",
    "await poll(true)",
    "st.failoverPhase",
  ]) {
    assert.ok(html.includes(needle), `Expected ${needle} in studio/index.html`);
  }
  assert.ok(!/@keyframes acc-dialog-in[^}]*scale\(/.test(html), "acc-dialog-in must not scale targets below 44px");
  assert.ok(!html.includes("renderStatus.plan") && !html.includes("renderStatus.credits") && !html.includes("clearHeaderBalance"));
  assert.ok(html.indexOf("await poll(true)") < html.indexOf("loadCast().then"));

  const { catalog } = loadEnTranslator();
  for (const code of Object.values(ERROR_CODES)) {
    assert.ok(catalog[`error.${code}`], `Missing locale error.${code}`);
  }
  for (const monitorKey of [
    "account.monitor.empty",
    "account.monitor.creditsBadge",
    "account.monitor.attemptsBadge",
    "account.monitor.retryFailedOne",
    "account.monitor.retryFailedMany",
    "account.failover.toggleLabel",
    "account.drafts.clearMismatched",
  ]) {
    assert.ok(catalog[monitorKey], `Missing ${monitorKey}`);
  }
  for (const prunedKey of [
    "account.badges.enabled",
    "hint.chromeClosed",
    "hint.loginReverted",
    "error.INVALID_LABEL",
    "error.LOGIN_CANCELLED",
    "error.NEW_PROJECT_FAILED",
  ]) {
    assert.equal(catalog[prunedKey], undefined, `Pruned key ${prunedKey} should not exist`);
  }
});
