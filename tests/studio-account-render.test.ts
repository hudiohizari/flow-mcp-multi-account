import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  esc,
  renderAccountList,
  renderActionAlert,
  renderDraftMismatchBanner,
  renderHeaderPills,
  renderHintBox,
  renderMonitorJobs,
  renderStateBanner,
  renderTrashDialogContent,
  svgIcon,
  type SvgIconName,
} from "../dist/studio/account-render.js";
import { createTranslator, flattenLocale, type AccountItem } from "../dist/studio/account-state.js";

const rawEn = JSON.parse(readFileSync(join(process.cwd(), "src/locales/en.json"), "utf8")) as unknown;
const t = createTranslator(flattenLocale(rawEn));

function makeAcc(overrides: Partial<AccountItem> = {}): AccountItem {
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

test("esc, svgIcon, renderHeaderPills, renderHintBox, renderStateBanner, and renderActionAlert", () => {
  assert.equal(esc(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
  assert.equal(esc(null), "");

  const icons: SvgIconName[] = [
    "user-circle",
    "plus",
    "arrow-up",
    "arrow-down",
    "refresh",
    "folder-plus",
    "log-in",
    "pencil",
    "trash",
    "x",
    "alert-triangle",
    "check",
  ];
  for (const name of icons) {
    const svg = svgIcon(name);
    assert.ok(svg.includes('stroke-width="1.75"'));
    assert.ok(svg.includes('aria-hidden="true"'));
  }

  const fullHeader = renderHeaderPills(
    {
      tallyClass: "ready",
      statusText: "Ready",
      plan: "Pro",
      credits: 450,
      pillText: "Account: Primary",
      pillAria: "Open accounts manager",
      pillTitle: "Primary",
      pillTone: "ready",
      hintText: null,
      showNewProjectBtn: false,
      failoverPhase: null,
    },
    t,
  );
  assert.ok(fullHeader.includes("Pro"));
  assert.ok(fullHeader.includes("450"));
  assert.ok(fullHeader.includes('title="Primary"'));

  const minHeader = renderHeaderPills(
    {
      tallyClass: "down",
      statusText: "Offline",
      plan: undefined,
      credits: undefined,
      pillText: "Accounts",
      pillAria: "Accounts",
      pillTitle: "",
      pillTone: "dim",
      hintText: null,
      showNewProjectBtn: false,
      failoverPhase: null,
    },
    t,
  );
  assert.ok(!minHeader.includes('title="'));

  assert.equal(renderHintBox(null, false, t), "");
  assert.ok(renderHintBox("Wait", false, t).includes("Wait"));
  assert.ok(renderHintBox(null, true, t).includes('id="newProjectBtn"'));
  assert.ok(renderHintBox("Open one", true, t).includes('id="newProjectBtn"'));
  const phaseHint = renderHintBox(null, false, t, {
    stage: "switching",
    fromAccountId: "default",
    fromLabel: "Primary",
    toAccountId: "b1",
    toLabel: "Backup 1",
    startedAt: "now",
  });
  assert.ok(phaseHint.includes("acc-hint-failover"));
  assert.ok(phaseHint.includes("Backup 1"));

  assert.ok(renderStateBanner({ kind: "loading" }, t).includes(t("account.states.loading.heading")));
  const errorBanner = renderStateBanner({ kind: "error", message: "corrupt", code: "REGISTRY_CORRUPT", accounts: [], activeAccountId: null }, t);
  assert.ok(errorBanner.includes("corrupt"));
  assert.ok(errorBanner.includes('data-acc-banner-action="retry"'));
  assert.ok(renderStateBanner({ kind: "switching", accounts: [], activeAccountId: "default", targetId: "b1" }, t).includes(t("account.states.switching.heading")));
  assert.ok(
    renderStateBanner(
      {
        kind: "switching",
        accounts: [],
        activeAccountId: "default",
        targetId: "b1",
        failoverPhase: { stage: "evaluating", fromAccountId: "default", fromLabel: "Primary", startedAt: "now" },
      },
      t,
    ).includes(t("account.failover.phases.evaluating.heading")),
  );
  assert.ok(renderStateBanner({ kind: "authInProgress", accounts: [], activeAccount: makeAcc(), pendingLogin: null }, t).includes(t("hint.authInProgress")));
  const emptyBanner = renderStateBanner({ kind: "empty", accounts: [makeAcc()], activeAccount: makeAcc() }, t);
  assert.ok(emptyBanner.includes(t("account.states.empty.heading")));
  assert.ok(emptyBanner.includes(t("account.states.empty.description")));
  assert.ok(!emptyBanner.includes('data-acc-banner-action="add"'));
  assert.ok(!emptyBanner.includes("acc-banner-actions"));
  assert.ok(renderStateBanner({ kind: "populated", accounts: [makeAcc()], activeAccount: makeAcc() }, t).includes(t("account.states.populated.heading")));

  assert.equal(renderActionAlert(null, t), "");
  assert.ok(renderActionAlert({ message: "Need auth", code: "AUTH_REQUIRED" }, t).includes('data-acc-banner-action="login"'));
  assert.ok(renderActionAlert({ message: "Missing", code: "PROFILE_MISSING" }, t).includes('data-acc-banner-action="login"'));
  assert.ok(renderActionAlert({ message: "No proj", code: "NOT_IN_PROJECT" }, t).includes('data-acc-banner-action="new-project"'));
  assert.ok(renderActionAlert({ message: "Busy", code: "CHROME_BUSY" }, t).includes('data-acc-banner-action="retry"'));
});

test("renderAccountList covers loading skeletons, error hiding, TTL credit badges, all row badges/actions, rename form, and trash dialog", () => {
  const nowMs = Date.parse("2026-11-26T12:00:00.000Z");
  const recentIso = new Date(nowMs - 3600_000).toISOString();
  const skel = renderAccountList({
    view: { kind: "loading" },
    renamingId: null,
    renameDraft: "",
    renameError: null,
    inFlight: null,
    busy: false,
    locale: "en-US",
    nowMs,
    t,
  });
  assert.ok(skel.includes("acc-skel"));

  const errList = renderAccountList({
    view: { kind: "error", message: "err", code: "REGISTRY_CORRUPT", accounts: [], activeAccountId: null },
    renamingId: null,
    renameDraft: "",
    renameError: null,
    inFlight: null,
    busy: false,
    locale: "en-US",
    nowMs,
    t,
  });
  assert.equal(errList, "");

  const a1 = makeAcc({
    plan: "Pro",
    creditsRemaining: 1200,
    balanceUpdatedAt: "2026-11-25T10:00:00.000Z",
    lastProjectTitle: "MyFilm",
    needsRelogin: true,
  });
  const a2 = makeAcc({
    id: "b1",
    slug: "b1",
    label: "Backup 1",
    isDefault: false,
    enabled: false,
    priority: 2,
    active: false,
    creditsRemaining: 0,
    balanceUpdatedAt: recentIso,
    lastProjectUrl: "https://flow.google.com/project/abc",
  });
  const a3 = makeAcc({
    id: "b2",
    slug: "b2",
    label: "Backup 2",
    isDefault: false,
    enabled: true,
    priority: 3,
    active: false,
    creditsRemaining: 10,
    balanceUpdatedAt: recentIso,
    exhaustedMinCost: 15,
    exhaustedAt: recentIso,
  });

  const populatedHtml = renderAccountList({
    view: { kind: "populated", accounts: [a1, a2, a3], activeAccount: a1 },
    renamingId: "b1",
    renameDraft: "x".repeat(65),
    renameError: "Too long",
    inFlight: null,
    busy: false,
    locale: "en-US",
    nowMs,
    t,
  });
  assert.ok(populatedHtml.includes(t("account.badges.active")));
  assert.ok(populatedHtml.includes(t("account.badges.primary")));
  assert.ok(populatedHtml.includes(t("account.badges.disabled")));
  assert.ok(populatedHtml.includes(t("account.badges.needsSignIn")));
  assert.ok(populatedHtml.includes(esc(t("account.badges.zeroCredits"))));
  assert.ok(populatedHtml.includes(esc(t("account.badges.lowCredits"))));
  assert.ok(populatedHtml.includes("acc-meta-ttl"));
  assert.ok(populatedHtml.includes("acc-meta-detail"));
  assert.ok(populatedHtml.includes(t("account.credits.freeFramesUnaffected")));
  assert.ok(populatedHtml.includes("MyFilm"));
  assert.ok(populatedHtml.includes("https://flow.google.com/project/abc"));
  assert.ok(populatedHtml.includes('class="acc-counter tabular over"'));
  assert.ok(populatedHtml.includes('aria-invalid="true"'));

  const switchingHtml = renderAccountList({
    view: { kind: "switching", accounts: [a1, a3], activeAccountId: "default", targetId: "b2" },
    renamingId: "default",
    renameDraft: "Primary",
    renameError: null,
    inFlight: { kind: "switch", id: "b2" },
    busy: true,
    locale: "en-US",
    nowMs,
    t,
  });
  assert.ok(switchingHtml.includes(t("account.badges.switching")));
  assert.ok(switchingHtml.includes(t("account.actions.switching")));

  const busyHtml = renderAccountList({
    view: { kind: "populated", accounts: [a1, makeAcc({ id: "b1", slug: "b1", label: "Backup 1", isDefault: false, priority: 2, active: false }), a3], activeAccount: a1 },
    renamingId: null,
    renameDraft: "",
    renameError: null,
    inFlight: null,
    busy: true,
    locale: "en-US",
    nowMs,
    t,
  });
  const busyText = t("account.disabled.busySwitch");
  const rows = busyHtml.split('<li class="acc-row"').slice(1);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.split(busyText).length - 1, 1);
    const renderedIds = new Set([...row.matchAll(/<span id="([^"]+)"/g)].map((m) => m[1]));
    for (const ref of row.matchAll(/aria-describedby="([^"]+)"/g)) {
      assert.ok(renderedIds.has(ref[1]), `Missing rendered reason span for ${ref[1]}`);
    }
  }

  const inflightSwitch = renderAccountList({
    view: { kind: "populated", accounts: [a1, a3], activeAccount: a1 },
    renamingId: null,
    renameDraft: "",
    renameError: null,
    inFlight: { kind: "switch", id: "b2" },
    busy: false,
    locale: "en-US",
    nowMs,
    t,
  });
  assert.ok(inflightSwitch.includes(t("account.actions.switching")));

  const inflightRefresh = renderAccountList({
    view: { kind: "populated", accounts: [a1, a3], activeAccount: a1 },
    renamingId: "default",
    renameDraft: "Primary",
    renameError: null,
    inFlight: { kind: "refresh", id: "default" },
    busy: false,
    locale: "en-US",
    nowMs,
    t,
  });
  assert.ok(inflightRefresh.includes(t("account.actions.refreshing")));

  const inflightNewProj = renderAccountList({
    view: { kind: "populated", accounts: [a1, a3], activeAccount: a1 },
    renamingId: "default",
    renameDraft: "Primary",
    renameError: null,
    inFlight: { kind: "newProject", id: "default" },
    busy: false,
    locale: "en-US",
    nowMs,
    t,
  });
  assert.ok(inflightNewProj.includes(t("account.actions.creatingProject")));

  const inflightRename = renderAccountList({
    view: { kind: "populated", accounts: [a1, a3], activeAccount: a1 },
    renamingId: "default",
    renameDraft: "Primary 2",
    renameError: null,
    inFlight: { kind: "rename", id: "default" },
    busy: false,
    locale: "en-US",
    nowMs,
    t,
  });
  assert.ok(inflightRename.includes(t("account.actions.saving")));

  const trashIdle = renderTrashDialogContent(a3, "the Mac's Trash", false, t);
  assert.ok(trashIdle.includes("autofocus"));
  assert.ok(trashIdle.includes("Move to the Mac&#39;s Trash"));

  const trashBusy = renderTrashDialogContent(a3, "the Mac's Trash", true, t);
  assert.ok(trashBusy.includes('aria-busy="true"'));
  assert.ok(trashBusy.includes(t("account.actions.removing")));
});

test("renderMonitorJobs renders failover strip, attribution badge, trail, portable retry, bound guard, and draft banners", () => {
  const media = (p: string) => `/media?path=${encodeURIComponent(p)}`;
  assert.ok(renderMonitorJobs([], "default", "Primary", media, t).includes(t("account.monitor.empty")));
  const emptyPhaseHtml = renderMonitorJobs([], "default", "Primary", media, t, {
    stage: "reverting",
    fromAccountId: "default",
    fromLabel: "Primary",
    startedAt: "now",
  });
  assert.ok(emptyPhaseHtml.includes("acc-failover-strip"));
  assert.ok(emptyPhaseHtml.includes(t("account.monitor.empty")));

  const html = renderMonitorJobs(
    [
      {
        id: "j-run",
        status: "running",
        accountId: "b1",
        accountLabel: "Backup 1",
        portable: true,
        failoverFrom: { accountId: "default", accountLabel: "Primary" },
        failoverAttempts: [
          { accountId: "b2", accountLabel: "Backup 2", status: "skipped", reason: "disabled" },
          { accountId: "b1", accountLabel: "Backup 1", status: "succeeded", reason: "verified" },
        ],
        project: "/tmp/MyFilm",
        scene: "scene-01",
        prompt: "Walk",
        progress: "abc",
        credits: 20,
        attempts: 2,
        note: "Working",
        files: ["/tmp/a.mp4", "/tmp/b.m4a", "/tmp/c.png"],
      },
      {
        id: "j-run-pct",
        status: "running",
        project: "/tmp/MyFilm",
        scene: "scene-01b",
        progress: "55%",
      },
      {
        id: "j-run-none",
        status: "running",
        project: "/tmp/MyFilm",
        scene: "scene-01c",
      },
      {
        id: "j-queued",
        status: "queued",
        scene: "scene-02",
        prompt: "Wait",
        attempts: 1,
        files: [],
      },
      {
        id: "j-cross",
        status: "failed",
        accountId: "a1",
        accountLabel: "Backup 1",
        portable: false,
        project: "/tmp/MyFilm",
        scene: "scene-03",
        prompt: "Failed",
        error: "Timed out",
      },
      {
        id: "j-portable-cross",
        status: "failed",
        accountId: "a1",
        accountLabel: "Backup 1",
        portable: true,
        project: "/tmp/MyFilm",
        scene: "scene-03b",
        prompt: "Portable failed",
      },
      {
        id: "j-done-1",
        status: "done",
        accountId: "default",
        accountLabel: "Primary",
        project: "/tmp/MyFilm",
        scene: "scene-04",
        prompt: "Partial 1",
        failed_scenes: [2],
      },
      {
        id: "j-done-2",
        status: "done",
        accountId: "default",
        accountLabel: "Primary",
        project: "/tmp/MyFilm",
        scene: "scene-05",
        prompt: "Partial 2",
        failed_scenes: [1, 3],
      },
    ],
    "default",
    "Primary",
    media,
    t,
    { stage: "switching", fromAccountId: "default", fromLabel: "Primary", toAccountId: "b1", toLabel: "Backup 1", startedAt: "now" },
  );
  assert.ok(html.includes("acc-failover-strip"));
  assert.ok(html.includes("acc-job-badge"));
  assert.ok(html.includes("Backup 1 (failover from Primary)"));
  assert.ok(html.includes("acc-failover-trail"));
  assert.ok(html.includes("acc-portable-retry-hint"));
  assert.ok(html.includes('data-retry="j-portable-cross">Retry</button>'));
  assert.ok(html.includes(esc(t("account.monitor.retryBoundReason", { jobAccount: "Backup 1" }))));
  assert.ok(html.includes('width:4%'));
  assert.ok(html.includes("<video "));
  assert.ok(html.includes("<audio "));
  assert.ok(html.includes("<img "));
  assert.ok(html.includes(t("account.monitor.creditsBadge", { count: 20 })));
  assert.ok(html.includes(t("account.monitor.attemptsBadge", { count: 2 })));
  assert.ok(html.includes(`>${t("account.actions.cancel")}<`));
  assert.ok(html.includes('data-cancel="j-queued"'));
  assert.ok(html.includes('id="retry-guard-j-cross"'));
  assert.ok(html.includes('disabled aria-describedby="retry-guard-j-cross"'));
  assert.ok(html.includes('data-open-accounts="true"'));
  assert.ok(html.includes(`${t("account.monitor.retryFailedOne", { count: 1 })}<`));
  assert.ok(html.includes(`${t("account.monitor.retryFailedMany", { count: 2 })}<`));

  assert.equal(renderDraftMismatchBanner("frames", null, false, t), "");
  const framesSwitch = renderDraftMismatchBanner("frames", { sourceLabels: '"Primary"', switchTarget: { id: "a1", label: "Primary" }, activeLabel: "Backup 1" }, false, t);
  assert.ok(framesSwitch.includes('data-draft-clear="frames"'));
  assert.ok(framesSwitch.includes('data-draft-switch="a1"'));
  assert.ok(framesSwitch.includes(t("account.drafts.framesHeading")));

  const framesAgent = renderDraftMismatchBanner("frames", { sourceLabels: "previous account", switchTarget: null, activeLabel: "Backup 1" }, true, t);
  assert.ok(framesAgent.includes('data-open-accounts="true"'));
  assert.ok(framesAgent.includes("ignored while Flow agent is selected"));

  const shotsBanner = renderDraftMismatchBanner("shots", { sourceLabels: '"Primary"', switchTarget: null, activeLabel: "Backup 1" }, false, t);
  assert.ok(shotsBanner.includes(t("account.drafts.shotsHeading")));

  const castBanner = renderDraftMismatchBanner("cast", { sourceLabels: '"Primary"', switchTarget: { id: "a1", label: "Primary" }, activeLabel: "Backup 1" }, false, t);
  assert.ok(castBanner.includes(t("account.drafts.castHeading")));
});
