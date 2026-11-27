import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createAccountUi, initAccountUi } from "../dist/studio/account-ui.js";
import type {
  AccountItem,
  AccountUiEnv,
  DocumentLike,
  ElementLike,
  EventLike,
  StorageLike,
  StudioBridge,
  StudioSlotRef,
  StudioStatusPayload,
} from "../dist/studio/account-types.js";

const LOCALE_EN = JSON.parse(readFileSync(join(process.cwd(), "src/locales/en.json"), "utf8")) as unknown;

class MockElement implements ElementLike {
  id: string;
  hidden = false;
  disabled = false;
  value = "";
  textContent: string | null = "";
  private _innerHTML = "";
  open = false;
  focused = false;
  attrs = new Map<string, string>();
  listeners = new Map<string, ((ev: EventLike) => unknown)[]>();
  parent: MockElement | null = null;
  onInnerHtmlChange?: (html: string) => void;

  constructor(id: string) {
    this.id = id;
  }

  get innerHTML(): string {
    return this._innerHTML;
  }

  set innerHTML(val: string) {
    this._innerHTML = val;
    if (this.onInnerHtmlChange) this.onInnerHtmlChange(val);
  }

  closest(selector: string): ElementLike | null {
    let cur: MockElement | null = this;
    while (cur) {
      if (cur.matches(selector)) return cur;
      cur = cur.parent;
    }
    return null;
  }

  private matches(selector: string): boolean {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    const eq = selector.match(/^\[([a-z0-9-]+)="([^"]*)"\]$/i);
    if (eq) return this.attrs.get(eq[1]) === eq[2];
    const has = selector.match(/^\[([a-z0-9-]+)\]$/i);
    if (has) return this.attrs.has(has[1]);
    return false;
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  focus(): void {
    this.focused = true;
  }

  showModal(): void {
    this.open = true;
  }

  close(): void {
    this.open = false;
  }

  addEventListener(type: string, listener: (ev: EventLike) => unknown): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }

  async dispatch(type: string, target: MockElement = this, relatedTarget: MockElement | null = null): Promise<boolean> {
    let prevented = false;
    const ev: EventLike = {
      target,
      relatedTarget,
      preventDefault: () => {
        prevented = true;
      },
    };
    for (const fn of this.listeners.get(type) ?? []) {
      await fn(ev);
    }
    return prevented;
  }
}

function makeEnv(opts: { fetchMode?: "ok" | "404" | "throw"; initialStorage?: Record<string, string>; nowMs?: () => number } = {}) {
  const els = new Map<string, MockElement>();
  const dynamic = new Map<string, MockElement>();
  const ids = [
    "status",
    "hint",
    "jobs",
    "accountsDialog",
    "accDialogTitle",
    "accDialogSubtitle",
    "accDialogClose",
    "accStateBanner",
    "accActionAlert",
    "accToolbar",
    "accAddToggle",
    "accFailoverRow",
    "accFailoverLabel",
    "accFailoverToggle",
    "accFailoverHelper",
    "accFailoverEmptyNote",
    "accFailoverLockReason",
    "accAddPanel",
    "accAddHeading",
    "accAddForm",
    "accAddLabel",
    "accAddInput",
    "accAddHelper",
    "accAddCount",
    "accAddError",
    "accAddSubmit",
    "accAddCancel",
    "accList",
    "accountTrashDialog",
    "accTrashBody",
    "newProjectDialog",
    "newProjTitle",
    "newProjDesc",
    "newProjForm",
    "newProjLabel",
    "newProjTitleInput",
    "newProjConfirm",
    "newProjCancel",
  ];
  for (const id of ids) els.set(id, new MockElement(id));

  const accList = els.get("accList")!;
  accList.onInnerHtmlChange = (html) => {
    dynamic.clear();
    for (const tagMatch of html.matchAll(/<([a-z0-9]+)\s+([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
      const attrsRaw = tagMatch[2];
      const id = tagMatch[3];
      const el = new MockElement(id);
      for (const a of attrsRaw.matchAll(/\b([a-z0-9-]+)="([^"]*)"/gi)) {
        if (a[1] === "value") el.value = a[2];
        else el.setAttribute(a[1], a[2]);
      }
      dynamic.set(id, el);
    }
  };

  const doc: DocumentLike = {
    getElementById: (id) => els.get(id) ?? dynamic.get(id) ?? null,
  };

  const store = new Map<string, string>(Object.entries(opts.initialStorage ?? {}));
  const storage: StorageLike = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
  };

  const mode = opts.fetchMode ?? "ok";
  const fetchFn: typeof fetch = async () => {
    if (mode === "throw") throw new Error("net down");
    if (mode === "404") return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(LOCALE_EN), { status: 200 });
  };

  const env: AccountUiEnv = {
    doc,
    storage,
    fetchFn,
    locale: "en-US",
    nowMs: opts.nowMs ?? (() => Date.parse("2026-11-26T12:00:00.000Z")),
  };
  return { els, dynamic, env, store };
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

function makeStatus(overrides: Partial<StudioStatusPayload> = {}): StudioStatusPayload {
  const a1 = makeAccount();
  return {
    flow: {
      url: "https://flow.google.com/project/11111111-1111-1111-1111-111111111111",
      connected: true,
      signedIn: true,
      inProject: true,
      authInProgress: false,
      plan: "Pro",
      credits_remaining: 500,
    },
    activeAccount: a1,
    activeAccountId: a1.id,
    accounts: [a1],
    pendingLogin: null,
    registryError: null,
    busy: false,
    switchInProgress: false,
    jobs: [],
    ...overrides,
  };
}

function makeBridge(
  handler: (method: string, body?: Record<string, unknown>, opts?: { signal?: AbortSignal }) => Promise<unknown>,
  overrides: Partial<StudioBridge> = {},
) {
  const calls: { method: string; body?: Record<string, unknown> }[] = [];
  const toasts: { msg: string; bad: boolean }[] = [];
  const polls: boolean[] = [];
  const resets: string[] = [];
  let live = true;
  let guardOk = true;
  let castImage: StudioSlotRef | null = null;
  const studioState = {
    tab: "frames",
    frames: {
      engine: "exact",
      scenes: [{ prompt: "Frame 1", first: { asset: "Hero" }, last: { path: "/p/1.png" }, refs: [{ asset: "Hero" }, { path: "/p/ref.png" }] }],
    },
    shots: { scenes: [{ prompt: "Shot 1", first: null, last: null, refs: [] as StudioSlotRef[] }] },
  };

  const bridge: StudioBridge = {
    api: async <T>(method: string, body?: Record<string, unknown>, opts?: { signal?: AbortSignal }) => {
      calls.push({ method, body });
      return (await handler(method, body, opts)) as T;
    },
    media: (p) => `/media?path=${encodeURIComponent(p)}`,
    toast: (msg, bad = false) => toasts.push({ msg, bad }),
    guard: () => guardOk,
    isLive: () => live,
    getPlace: () => ({ computer: "this Mac", bin: "the Mac's Trash", binShort: "Mac Trash", platform: "darwin" }),
    getStudioState: () => studioState,
    getCastImage: () => castImage,
    setCastImage: (val) => {
      castImage = val;
    },
    saveStudioState: () => resets.push("save"),
    renderAll: () => resets.push("renderAll"),
    clearLib: () => resets.push("clearLib"),
    clearAssetPickers: () => resets.push("clearAssetPickers"),
    clearCast: () => resets.push("clearCast"),
    reloadCast: async (_sig, epoch) => void resets.push(`reloadCast:${epoch}`),
    setSwitchBusy: (b) => void resets.push(`switchBusy:${b}`),
    triggerPoll: async (d) => void polls.push(d),
    ...overrides,
  };

  return {
    bridge,
    calls,
    toasts,
    polls,
    resets,
    studioState,
    setLive: (v: boolean) => {
      live = v;
    },
    setGuard: (v: boolean) => {
      guardOk = v;
    },
    setCastImageLocal: (v: StudioSlotRef | null) => {
      castImage = v;
    },
  };
}

test("createAccountUi requires DOM elements, handles locale fetch fallback, and supports initAccountUi globals", async () => {
  const prevWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const emptyDoc: DocumentLike = { getElementById: () => null };
    const { bridge } = makeBridge(async (m) => (m === "accounts" ? { activeAccountId: "default", pendingLogin: null, registryError: null, accounts: [makeAccount()] } : {}));
    await assert.rejects(
      () => createAccountUi(bridge, { doc: emptyDoc, storage: { getItem: () => null, setItem: () => undefined }, fetchFn: fetch, locale: "en-US", nowMs: () => Date.now() }),
      /Missing Studio element #status/,
    );

    const env404 = makeEnv({ fetchMode: "404" });
    const ui404 = await createAccountUi(bridge, env404.env);
    assert.equal(ui404.t("account.dialog.title"), "account.dialog.title");

    const envThrow = makeEnv({ fetchMode: "throw" });
    const uiThrow = await createAccountUi(bridge, envThrow.env);
    assert.equal(uiThrow.t("account.dialog.title"), "account.dialog.title");
    assert.equal(warnings.length, 3);

    // Default env branch of initAccountUi with temporary global shims cleaned up in finally
    const prevDoc = Object.getOwnPropertyDescriptor(globalThis, "document");
    const prevStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const prevFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    const prevNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    try {
      Object.defineProperty(globalThis, "document", { value: env404.env.doc, configurable: true });
      Object.defineProperty(globalThis, "localStorage", { value: env404.env.storage, configurable: true });
      // Assert global fetch is not called with env as `this` (would throw Illegal invocation in Chromium)
      const strictFetch = function (this: unknown) {
        if (this !== undefined && this !== globalThis) {
          throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
        }
        return Promise.resolve(new Response(JSON.stringify(LOCALE_EN), { status: 200 }));
      };
      Object.defineProperty(globalThis, "fetch", { value: strictFetch, configurable: true });
      Object.defineProperty(globalThis, "navigator", { value: { language: "" }, configurable: true });
      const uiDef = await initAccountUi(bridge);
      assert.equal(uiDef.t("account.dialog.title"), "Accounts");
      assert.deepEqual(uiDef.stampSlot({ asset: "PreBoot" }), { asset: "PreBoot" });
      await uiDef.openAccountsDialog();
      Object.defineProperty(globalThis, "navigator", { value: { language: "en-GB" }, configurable: true });
      const uiDefLang = await initAccountUi(bridge);
      assert.equal(uiDefLang.t("account.header.pillLoading"), "Accounts");
    } finally {
      if (prevDoc === undefined) delete (globalThis as Record<string, unknown>).document;
      else Object.defineProperty(globalThis, "document", prevDoc);
      if (prevStorage === undefined) delete (globalThis as Record<string, unknown>).localStorage;
      else Object.defineProperty(globalThis, "localStorage", prevStorage);
      if (prevFetch === undefined) delete (globalThis as Record<string, unknown>).fetch;
      else Object.defineProperty(globalThis, "fetch", prevFetch);
      if (prevNav === undefined) delete (globalThis as Record<string, unknown>).navigator;
      else Object.defineProperty(globalThis, "navigator", prevNav);
    }
  } finally {
    console.warn = prevWarn;
  }
});

test("onStatus manages account switching, sticky balance clearing, stale reset, revert toasts, and one-shot poll(true)", async () => {
  const { els, env, store } = makeEnv({ initialStorage: { lastAccountId: "a1" } });
  const b = makeBridge(async () => ({}));
  const ui = await initAccountUi(b.bridge, env);

  // Header pill renders immediately on init before onStatus resolves
  assert.ok(els.get("status")!.innerHTML.includes('id="accountPill"'));
  assert.ok(els.get("status")!.innerHTML.includes("Connecting..."));

  ui.renderOffline(false);
  assert.ok(els.get("status")!.innerHTML.includes("Not connected"));

  // Boot onto different account a2 -> triggers stale reset & reloadCast epoch 1
  const a1 = makeAccount({ id: "a1", label: "Primary", active: false });
  const a2 = makeAccount({ id: "a2", slug: "b1", label: "Backup 1", isDefault: false, priority: 2, active: true });
  ui.onStatus(
    makeStatus({
      activeAccount: a2,
      activeAccountId: "a2",
      accounts: [a1, a2],
      flow: { url: "https://flow.google.com/", connected: true, signedIn: true, inProject: false, authInProgress: false },
    }),
    false,
  );
  assert.equal(ui.getAccountEpoch(), 1);
  assert.equal(store.get("lastAccountId"), "a2");
  assert.equal(store.get("lastAccountLabel"), "Backup 1");
  assert.ok(b.resets.includes("reloadCast:1"));
  assert.deepEqual(b.polls, [true]); // one-shot poll(true) on !inProject -> signedIn
  assert.deepEqual(b.studioState.frames.scenes[0].first, { asset: "Hero", assetAccountId: "a1", assetAccountLabel: "Primary" });
  assert.deepEqual(b.studioState.frames.scenes[0].last, { path: "/p/1.png" });
  assert.ok(b.toasts.some((x) => x.msg.includes("your unsent scene drafts stay preserved")));

  // Stamp slot, view slot, draft banner, roll/cast block, and clear mismatched assets
  assert.deepEqual(ui.stampSlot({ asset: "NewPick" }), { asset: "NewPick", assetAccountId: "a2", assetAccountLabel: "Backup 1" });
  assert.equal(ui.getSlotView(b.studioState.frames.scenes[0].first).badgeText, "From Primary");
  assert.ok(ui.renderDraftBanner("frames").includes('data-draft-clear="frames"'));
  assert.ok(ui.getRollBlock()?.blockedReason.includes('"Primary"'));
  b.setCastImageLocal({ asset: "CastOld", assetAccountId: "a1", assetAccountLabel: "Primary" });
  assert.ok(ui.getCastBlock()?.blockedReason.includes('"Primary"'));
  ui.clearMismatchedDrafts("frames");
  ui.clearMismatchedDrafts("cast");
  assert.equal(b.studioState.frames.scenes[0].first, null);
  assert.equal(b.studioState.frames.scenes[0].refs.length, 1);
  assert.equal(ui.getRollBlock(), null);

  // Switching with zero preserved asset: refs uses hint.staleCleared
  ui.onStatus(
    makeStatus({
      activeAccount: a1,
      activeAccountId: "a1",
      accounts: [{ ...a1, active: true }, { ...a2, active: false }],
      pendingLogin: null,
    }),
    true,
  );
  assert.ok(b.toasts.some((x) => x.msg.includes("Cleared media lists")));

  // Pending login abort revert back to a1 -> populates Pro / 500 credits
  ui.onStatus(
    makeStatus({
      activeAccount: a2,
      activeAccountId: "a2",
      accounts: [a1, a2],
      pendingLogin: { targetAccountId: "a2", previousAccountId: "a1", startedAt: "now" },
    }),
    true,
  );
  ui.onStatus(
    makeStatus({
      activeAccount: a1,
      activeAccountId: "a1",
      accounts: [{ ...a1, active: true }, { ...a2, active: false }],
      pendingLogin: null,
    }),
    true,
  );
  assert.equal(ui.getAccountEpoch(), 4);
  assert.ok(els.get("status")!.innerHTML.includes("Pro"));
  assert.ok(els.get("status")!.innerHTML.includes("500 credits"));
  assert.ok(b.toasts.some((x) => x.msg.includes('Switched back to "Primary"')));

  // Switch where activeAccount is null (registry edge) and flow omits balance -> clears stale header pills
  ui.onStatus(
    makeStatus({
      activeAccount: null,
      activeAccountId: "a3",
      accounts: [],
      flow: { url: "", connected: false, signedIn: false, inProject: false, authInProgress: false },
    }),
    true,
  );
  assert.equal(ui.getAccountEpoch(), 5);
  assert.ok(!els.get("status")!.innerHTML.includes("Pro"));
  assert.ok(!els.get("status")!.innerHTML.includes("500 credits"));
  assert.equal(ui.stampSlot({ asset: "X" }).assetAccountLabel, undefined);
  assert.equal(ui.getRollBlock(), null);
  assert.equal(ui.getCastBlock(), null);
  assert.equal(ui.getAccountSignal().aborted, false);
  assert.ok(ui.renderJobs(makeStatus({ activeAccount: null, activeAccountId: null })).includes("Nothing queued"));
  assert.ok(ui.renderJobs(makeStatus({ failoverPhase: { stage: "evaluating", fromAccountId: "a1", fromLabel: "Primary", startedAt: "now" } })).includes("acc-failover-strip"));

  // Boot where persisted lastAccountId is missing from st.accounts, exercising lastAccountLabel fallback & null fallback
  const envGone = makeEnv({ initialStorage: { lastAccountId: "deleted-id", lastAccountLabel: "Old Label" } });
  const bGone = makeBridge(async () => ({}));
  const uiGone = await createAccountUi(bGone.bridge, envGone.env);
  uiGone.onStatus(makeStatus({ activeAccount: a2, activeAccountId: "a2", accounts: [a2] }), true);
  assert.equal(bGone.studioState.frames.scenes[0].first?.assetAccountLabel, "Old Label");

  const envGoneNoLabel = makeEnv({ initialStorage: { lastAccountId: "deleted-id" } });
  const bGone2 = makeBridge(async () => ({}));
  const uiGone2 = await createAccountUi(bGone2.bridge, envGoneNoLabel.env);
  uiGone2.onStatus(makeStatus({ activeAccount: a2, activeAccountId: "a2", accounts: [a2] }), true);
  assert.equal(bGone2.studioState.frames.scenes[0].first?.assetAccountId, "deleted-id");
  assert.equal(bGone2.studioState.frames.scenes[0].first?.assetAccountLabel, undefined);

  // Fresh install with no lastAccountId yet, followed by same-account poll
  const envFresh = makeEnv();
  const uiFresh = await createAccountUi(b.bridge, envFresh.env);
  uiFresh.onStatus(makeStatus({ flow: { url: "https://flow.google.com/project/1", connected: true, signedIn: true, inProject: true, authInProgress: false } }), true);
  assert.equal(envFresh.store.get("lastAccountId"), "default");
  uiFresh.onStatus(makeStatus({ flow: { url: "https://flow.google.com/project/1", connected: true, signedIn: true, inProject: true, authInProgress: false } }), true);

  // Boot when activeAccountId is null (no activeAccount), then resolves with activeAccountId === null edge
  const envNoActive = makeEnv();
  const uiNoActive = await createAccountUi(b.bridge, envNoActive.env);
  uiNoActive.onStatus(makeStatus({ activeAccount: null, activeAccountId: null, accounts: [] }), true);
});

test("initial header pill and loading skeleton are reachable before initial onStatus resolves", async () => {
  const { els, env } = makeEnv();
  let resolveAccounts!: (v: unknown) => void;
  const b = makeBridge(async (method) => {
    if (method === "accounts") return new Promise((r) => { resolveAccounts = r; });
    return {};
  });
  await createAccountUi(b.bridge, env);

  assert.ok(els.get("status")!.innerHTML.includes('id="accountPill"'));
  assert.ok(els.get("status")!.innerHTML.includes("Connecting..."));
  assert.ok(els.get("status")!.innerHTML.includes("Accounts"));

  const pillTarget = new MockElement("accountPill");
  await els.get("status")!.dispatch("click", pillTarget);
  assert.equal(els.get("accountsDialog")!.open, true);
  assert.ok(els.get("accList")!.innerHTML.includes("acc-skel"));
  assert.ok(els.get("accStateBanner")!.innerHTML.includes("Loading accounts..."));

  const a1 = makeAccount();
  resolveAccounts({ activeAccountId: "default", pendingLogin: null, registryError: null, accounts: [a1] });
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(els.get("accList")!.innerHTML.includes("Primary"));
  const emptyBannerHtml = els.get("accStateBanner")!.innerHTML;
  assert.ok(emptyBannerHtml.includes("Only one account so far"));
  assert.ok(emptyBannerHtml.includes("Add another Google account"));
  assert.ok(!emptyBannerHtml.includes('data-acc-banner-action="add"'));
  assert.equal(els.get("accToolbar")!.hidden, false);
  await els.get("accAddToggle")!.dispatch("click");
  assert.equal(els.get("accAddPanel")!.hidden, false);
  assert.equal(els.get("accAddToggle")!.getAttribute("aria-expanded"), "true");
  await els.get("accAddCancel")!.dispatch("click");
  assert.equal(els.get("accAddPanel")!.hidden, true);
  assert.equal(els.get("accAddToggle")!.getAttribute("aria-expanded"), "false");
});

test("Account dialog open, Add/Rename Reward-Early-Punish-Late validation, poll preservation, row actions, trash, new project, and jobs", async () => {
  const { els, env } = makeEnv();
  const a1 = makeAccount({ id: "default", label: "Primary", active: true });
  const a2 = makeAccount({ id: "b1", slug: "b1", label: "Backup 1", isDefault: false, priority: 2, active: false, enabled: true });
  let accountList = [a1, a2];
  let accountsHandler: () => Promise<unknown> = async () => ({
    activeAccountId: "default",
    pendingLogin: null,
    registryError: null,
    accounts: accountList,
  });

  let nextSwitchAlready = false;
  let nextRefreshBusy = false;
  let nextNewProjectTitle: string | undefined = "Fresh Film";

  const b = makeBridge(async (method, body) => {
    if (method === "accounts") return accountsHandler();
    if (method === "account_add") {
      const created = makeAccount({ id: "b2", slug: "b2", label: String(body?.label), isDefault: false, priority: 3, active: false });
      accountList = [...accountList, created];
      return { account: created, accounts: accountList };
    }
    if (method === "account_rename") {
      accountList = accountList.map((a) => (a.id === body?.id ? { ...a, label: String(body.label) } : a));
      return { account: accountList.find((a) => a.id === body?.id), accounts: accountList };
    }
    if (method === "account_switch") {
      const target = accountList.find((a) => a.id === body?.id)!;
      if (nextSwitchAlready) return { switched: false, alreadyActive: true, account: target };
      accountList = accountList.map((a) => ({ ...a, active: a.id === target.id }));
      return { switched: true, account: { ...target, active: true } };
    }
    if (method === "account_login") {
      return { account: accountList.find((a) => a.id === body?.id) };
    }
    if (method === "account_refresh") {
      const target = accountList.find((a) => a.id === body?.id)!;
      if (nextRefreshBusy) return { refreshed: false, busy: true, account: target };
      return { refreshed: true, account: target };
    }
    if (method === "account_enable") {
      accountList = accountList.map((a) => (a.id === body?.id ? { ...a, enabled: Boolean(body.enabled) } : a));
      return { account: accountList.find((a) => a.id === body?.id), accounts: accountList };
    }
    if (method === "account_reorder") {
      const ids = body?.ids as string[];
      accountList = ids.map((id, i) => ({ ...accountList.find((a) => a.id === id)!, priority: i + 1 }));
      return { accounts: accountList };
    }
    if (method === "account_remove") {
      accountList = accountList.filter((a) => a.id !== body?.id);
      return { removedId: body?.id, trashedTo: "/tmp/trash", accounts: accountList };
    }
    if (method === "new_project") {
      return nextNewProjectTitle ? { id: "p1", url: "https://flow.google.com/project/p1", title: nextNewProjectTitle } : { id: "p1", url: "https://flow.google.com/project/p1", title: "" };
    }
    return { ok: true };
  });

  const ui = await createAccountUi(b.bridge, env);

  // Offline click opens dialog with REMOTE_UNREACHABLE
  b.setLive(false);
  const pillTarget = new MockElement("accountPill");
  await els.get("status")!.dispatch("click", pillTarget);
  assert.equal(els.get("accountsDialog")!.open, true);
  assert.ok(els.get("accStateBanner")!.innerHTML.includes("Could not reach"));
  await els.get("accDialogClose")!.dispatch("click");
  assert.equal(els.get("accountsDialog")!.open, false);

  // Live open via delegated #status pill click + AbortError handling + non-abort error handling
  b.setLive(true);
  accountsHandler = async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  };
  await ui.openAccountsDialog();
  // Concurrent second open aborts previous and handles real error
  accountsHandler = async () => {
    throw Object.assign(new Error("Corrupt"), { code: "REGISTRY_CORRUPT" });
  };
  const p1 = ui.openAccountsDialog();
  const p2 = ui.openAccountsDialog();
  await Promise.all([p1, p2]);
  assert.ok(els.get("accStateBanner")!.innerHTML.includes("Corrupt"));

  // Banner retry recovers cleanly
  accountsHandler = async () => ({
    activeAccountId: "default",
    pendingLogin: null,
    registryError: null,
    accounts: accountList,
  });
  const retryBannerBtn = new MockElement("retryBanner");
  retryBannerBtn.setAttribute("data-acc-banner-action", "retry");
  await els.get("accountsDialog")!.dispatch("click", retryBannerBtn);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(els.get("accList")!.innerHTML.includes("Primary"));

  // Add account form: Reward Early, Punish Late + focus on invalid submit + poll preservation
  await els.get("accAddToggle")!.dispatch("click");
  assert.equal(ui.isEditingAccountForm(), true);
  const addInput = els.get("accAddInput")!;
  assert.equal(addInput.focused, true);

  // Blur when empty does not punish; typing before blur does not punish
  await addInput.dispatch("blur");
  assert.equal(addInput.getAttribute("aria-invalid"), "false");
  addInput.value = "a";
  await addInput.dispatch("input");
  assert.equal(addInput.getAttribute("aria-invalid"), "false");

  // Blur with whitespace punishes -> error clears on valid input
  addInput.value = "   ";
  await addInput.dispatch("blur");
  assert.equal(addInput.getAttribute("aria-invalid"), "true");
  addInput.value = "Studio 2";
  await addInput.dispatch("input");
  assert.equal(addInput.getAttribute("aria-invalid"), "false");

  // Background poll while Add panel is open preserves Add panel DOM
  ui.onStatus(makeStatus({ accounts: accountList }), false);
  assert.equal(els.get("accAddInput")!.value, "Studio 2");

  // Invalid submit blocks API & focuses input
  addInput.value = "Primary";
  addInput.focused = false;
  await els.get("accAddForm")!.dispatch("submit");
  assert.equal(addInput.focused, true);
  assert.equal(addInput.getAttribute("aria-invalid"), "true");

  // Valid submit when guard is false stops cleanly
  addInput.value = "Backup 2";
  b.setGuard(false);
  await els.get("accAddForm")!.dispatch("submit");
  b.setGuard(true);

  // Server error on add shows inline error & focuses
  const origAdd = b.bridge.api;
  b.bridge.api = async (m, body, o) => {
    if (m === "account_add") throw Object.assign(new Error("Duplicate on server"), { code: "DUPLICATE_LABEL" });
    return origAdd(m, body, o);
  };
  addInput.focused = false;
  await els.get("accAddForm")!.dispatch("submit");
  assert.equal(addInput.focused, true);
  b.bridge.api = origAdd;

  // Successful add closes panel (and guards overlapping submit while disabled)
  let releaseAdd!: (v: unknown) => void;
  b.bridge.api = (m, body, o) => {
    if (m === "account_add") return new Promise((r) => { releaseAdd = r; });
    return origAdd(m, body, o);
  };
  addInput.value = "Backup 2";
  const addPromise = els.get("accAddForm")!.dispatch("submit");
  assert.equal(els.get("accAddSubmit")!.disabled, true);
  await els.get("accAddForm")!.dispatch("submit"); // ignored while disabled
  const createdB2 = makeAccount({ id: "b2", slug: "b2", label: "Backup 2", isDefault: false, priority: 3, active: false });
  accountList = [...accountList, createdB2];
  releaseAdd({ account: createdB2, accounts: accountList });
  await addPromise;
  b.bridge.api = origAdd;
  assert.equal(els.get("accAddPanel")!.hidden, true);
  assert.ok(els.get("accList")!.innerHTML.includes("Backup 2"));

  // Toggle + Cancel Add panel via #accAddToggle and #accAddCancel in populated & authInProgress states
  assert.equal(els.get("accToolbar")!.hidden, false);
  await els.get("accAddToggle")!.dispatch("click");
  assert.equal(els.get("accAddPanel")!.hidden, false);
  assert.equal(els.get("accAddToggle")!.getAttribute("aria-expanded"), "true");
  await els.get("accAddToggle")!.dispatch("click");
  assert.equal(els.get("accAddPanel")!.hidden, true);
  assert.equal(els.get("accAddToggle")!.getAttribute("aria-expanded"), "false");
  await els.get("accAddToggle")!.dispatch("click");
  assert.equal(els.get("accAddPanel")!.hidden, false);
  await els.get("accAddCancel")!.dispatch("click");
  assert.equal(els.get("accAddPanel")!.hidden, true);

  ui.onStatus(makeStatus({ accounts: accountList, flow: { url: "https://flow.google.com/project/1", connected: true, signedIn: true, inProject: true, authInProgress: true } }), false);
  assert.equal(els.get("accToolbar")!.hidden, false);
  await els.get("accAddToggle")!.dispatch("click");
  assert.equal(els.get("accAddPanel")!.hidden, false);
  await els.get("accAddCancel")!.dispatch("click");
  assert.equal(els.get("accAddPanel")!.hidden, true);
  ui.onStatus(makeStatus({ accounts: accountList }), false);

  // Rename flow + focus preservation across poll
  const makeRowBtn = (act: string, id: string) => {
    const btn = new MockElement(`btn-${act}-${id}`);
    btn.setAttribute("data-acc-action", act);
    btn.setAttribute("data-id", id);
    return btn;
  };
  await els.get("accountsDialog")!.dispatch("click", makeRowBtn("rename", "unknown")); // missing id no-op
  await els.get("accountsDialog")!.dispatch("click", makeRowBtn("rename", "b1"));
  assert.equal(ui.isEditingAccountForm(), true);
  const renameInput = env.doc.getElementById("accRenameInput-b1") as MockElement;
  assert.equal(renameInput.focused, true);

  // Background poll during rename does NOT wipe renameInput
  ui.onStatus(makeStatus({ accounts: accountList }), false);
  assert.equal(env.doc.getElementById("accRenameInput-b1"), renameInput);

  // Focusout onto cancel button skips error; focusout elsewhere validates; input clears
  const cancelBtn = makeRowBtn("cancel-rename", "b1");
  await els.get("accList")!.dispatch("focusout", renameInput, cancelBtn);
  assert.equal(renameInput.getAttribute("aria-invalid"), "false");

  renameInput.value = "   ";
  await els.get("accList")!.dispatch("input", renameInput);
  await els.get("accList")!.dispatch("focusout", renameInput, null);
  assert.equal(renameInput.getAttribute("aria-invalid"), "true");

  // Invalid rename submit focuses input
  const renameForm = new MockElement("rf");
  renameForm.setAttribute("data-acc-rename-form", "b1");
  renameInput.focused = false;
  await els.get("accList")!.dispatch("submit", renameForm);
  assert.equal(renameInput.focused, true);

  // Non-matching list input/focusout/submit are harmless no-ops
  const otherEl = new MockElement("other");
  await els.get("accList")!.dispatch("input", otherEl);
  await els.get("accList")!.dispatch("focusout", otherEl);
  await els.get("accList")!.dispatch("submit", otherEl);

  // Valid rename submit
  renameInput.value = "Backup Renamed";
  await els.get("accList")!.dispatch("input", renameInput);
  await els.get("accList")!.dispatch("submit", renameForm);
  assert.ok(els.get("accList")!.innerHTML.includes("Backup Renamed"));

  // Cancel rename action
  await els.get("accountsDialog")!.dispatch("click", makeRowBtn("rename", "b1"));
  await els.get("accountsDialog")!.dispatch("click", makeRowBtn("cancel-rename", "b1"));
  assert.equal(ui.isEditingAccountForm(), false);

  // Overlapping rapid clicks are blocked by inFlight !== null guard
  let releaseSwitch!: (v: unknown) => void;
  let switchCalls = 0;
  let extraLoginCalls = 0;
  const origSwitchApi = b.bridge.api;
  b.bridge.api = async (m, body, o) => {
    if (m === "account_switch") {
      switchCalls++;
      return new Promise((r) => { releaseSwitch = r; });
    }
    if (m === "account_login") extraLoginCalls++;
    return origSwitchApi(m, body, o);
  };
  await els.get("accountsDialog")!.dispatch("click", makeRowBtn("switch", "b1"));
  await els.get("accountsDialog")!.dispatch("click", makeRowBtn("login", "default"));
  assert.equal(switchCalls, 1);
  assert.equal(extraLoginCalls, 0);
  accountList = accountList.map((a) => ({ ...a, active: a.id === "b1" }));
  releaseSwitch({ switched: true, account: accountList.find((a) => a.id === "b1") });
  await new Promise((r) => setTimeout(r, 5));
  b.bridge.api = origSwitchApi;

  // Row actions: switch (alreadyActive vs switched), login, banner login, refresh (ok vs busy), toggle (disable & enable), reorder (move-up, move-down, OOB)
  const clickDialog = async (el: MockElement) => {
    await els.get("accountsDialog")!.dispatch("click", el);
    await new Promise((r) => setTimeout(r, 0));
  };
  nextSwitchAlready = true;
  await clickDialog(makeRowBtn("switch", "b1"));
  nextSwitchAlready = false;
  await clickDialog(makeRowBtn("switch", "b1"));
  await clickDialog(makeRowBtn("login", "default"));
  const bannerLogin = new MockElement("bannerLogin");
  bannerLogin.setAttribute("data-acc-banner-action", "login");
  await clickDialog(bannerLogin);

  await clickDialog(makeRowBtn("refresh", "b1"));
  nextRefreshBusy = true;
  await clickDialog(makeRowBtn("refresh", "b1"));
  nextRefreshBusy = false;

  await clickDialog(makeRowBtn("toggle", "default")); // disable
  await clickDialog(makeRowBtn("toggle", "default")); // enable

  await clickDialog(makeRowBtn("move-up", "default")); // OOB
  await clickDialog(makeRowBtn("move-down", "b1"));
  await clickDialog(makeRowBtn("move-up", "b1"));

  // Non-row click inside accountsDialog is a no-op
  await clickDialog(new MockElement("bg"));

  // Row action error & guard false
  b.setGuard(false);
  await clickDialog(makeRowBtn("login", "b1"));
  b.setGuard(true);
  const origApi = b.bridge.api;
  b.bridge.api = async (m, body, o) => {
    if (m === "account_login") throw Object.assign(new Error("Disabled"), { code: "ACCOUNT_DISABLED" });
    return origApi(m, body, o);
  };
  await clickDialog(makeRowBtn("login", "b1"));
  assert.ok(els.get("accActionAlert")!.innerHTML.includes("Disabled"));
  b.bridge.api = origApi;

  // Trash dialog cancel, confirm error, confirm success, and missing target no-op
  await els.get("accountsDialog")!.dispatch("click", makeRowBtn("remove", "b2"));
  assert.equal(els.get("accountTrashDialog")!.open, true);
  const trashCancel = new MockElement("tc");
  trashCancel.setAttribute("data-trash-cancel", "true");
  await els.get("accountTrashDialog")!.dispatch("click", trashCancel);
  assert.equal(els.get("accountTrashDialog")!.open, false);

  const trashConfirm = new MockElement("tx");
  trashConfirm.setAttribute("data-trash-confirm", "true");
  await els.get("accountTrashDialog")!.dispatch("click", trashConfirm); // no target no-op

  await els.get("accountsDialog")!.dispatch("click", makeRowBtn("remove", "b2"));
  b.bridge.api = async (m, body, o) => {
    if (m === "account_remove") throw Object.assign(new Error("Unsafe path"), { code: "UNSAFE_ACCOUNT_PATH" });
    return origApi(m, body, o);
  };
  await els.get("accountTrashDialog")!.dispatch("click", trashConfirm);
  assert.equal(els.get("accountTrashDialog")!.open, false);
  assert.ok(els.get("accActionAlert")!.innerHTML.includes("Unsafe path"));
  b.bridge.api = origApi;

  await els.get("accountsDialog")!.dispatch("click", makeRowBtn("remove", "b2"));
  await els.get("accountTrashDialog")!.dispatch("click", trashConfirm);
  assert.ok(!els.get("accList")!.innerHTML.includes("Backup 2"));

  // New project dialog: #hint button, banner action, row action, cancel, guard false, titled & untitled, error
  const hintNewProj = new MockElement("newProjectBtn");
  await els.get("hint")!.dispatch("click", hintNewProj);
  assert.equal(els.get("newProjectDialog")!.open, true);
  await els.get("newProjCancel")!.dispatch("click");
  assert.equal(els.get("newProjectDialog")!.open, false);

  const bannerNewProj = new MockElement("bnp");
  bannerNewProj.setAttribute("data-acc-banner-action", "new-project");
  await els.get("accountsDialog")!.dispatch("click", bannerNewProj);
  assert.equal(els.get("newProjectDialog")!.open, true);
  await els.get("newProjCancel")!.dispatch("click");

  await els.get("accountsDialog")!.dispatch("click", makeRowBtn("new-project", "b1"));
  b.setGuard(false);
  await els.get("newProjForm")!.dispatch("submit");
  b.setGuard(true);

  els.get("newProjTitleInput")!.value = "My Title";
  let releaseNewProj!: (v: unknown) => void;
  let newProjCalls = 0;
  b.bridge.api = async (m, body, o) => {
    if (m === "new_project") {
      newProjCalls++;
      return new Promise((r) => { releaseNewProj = r; });
    }
    return origApi(m, body, o);
  };
  const newProjPromise = els.get("newProjForm")!.dispatch("submit");
  assert.equal(els.get("newProjConfirm")!.disabled, true);
  await els.get("newProjForm")!.dispatch("submit"); // ignored while disabled
  assert.equal(newProjCalls, 1);
  releaseNewProj({ id: "p1", url: "https://flow.google.com/project/p1", title: "Fresh Film" });
  await newProjPromise;
  b.bridge.api = origApi;
  assert.equal(els.get("newProjectDialog")!.open, false);

  nextNewProjectTitle = "";
  await els.get("accountsDialog")!.dispatch("click", makeRowBtn("new-project", "b1"));
  els.get("newProjTitleInput")!.value = "   ";
  await els.get("newProjForm")!.dispatch("submit");

  b.bridge.api = async (m, body, o) => {
    if (m === "new_project") throw Object.assign(new Error("Failed"), { code: "INVALID_STATE" });
    return origApi(m, body, o);
  };
  await els.get("newProjForm")!.dispatch("submit");
  b.bridge.api = origApi;

  // #status and #hint non-matching clicks are no-ops
  await els.get("status")!.dispatch("click", new MockElement("other"));
  await els.get("hint")!.dispatch("click", new MockElement("other"));

  // #jobs delegated clicks: open-accounts, retry, cancel, noop, error
  const openAcc = new MockElement("oa");
  openAcc.setAttribute("data-open-accounts", "true");
  await els.get("jobs")!.dispatch("click", openAcc);

  const retryBtn = new MockElement("rb");
  retryBtn.setAttribute("data-retry", "job-1");
  await els.get("jobs")!.dispatch("click", retryBtn);

  const cancelJobBtn = new MockElement("cb");
  cancelJobBtn.setAttribute("data-cancel", "job-2");
  await els.get("jobs")!.dispatch("click", cancelJobBtn);

  await els.get("jobs")!.dispatch("click", new MockElement("noop"));

  b.bridge.api = async () => {
    throw Object.assign(new Error("Account mismatch"), { code: "ACCOUNT_MISMATCH" });
  };
  await els.get("jobs")!.dispatch("click", retryBtn);
  assert.ok(b.toasts.some((x) => x.bad && x.msg.includes("Account mismatch")));
});

test("Automatic failover toggle in #accFailoverRow mutates pessimistically, preserves node across polls, and switches via draft CTA", async () => {
  const { els, env } = makeEnv();
  const a1 = makeAccount({ id: "default", label: "Primary", active: true });
  const a2 = makeAccount({ id: "b1", slug: "b1", label: "Backup 1", isDefault: false, priority: 2, active: false, enabled: true });
  let autoFailover = true;
  let releaseConfig!: (v: unknown) => void;
  let rejectNextConfig = false;

  const b = makeBridge(async (method, body) => {
    if (method === "accounts") {
      return { activeAccountId: "default", pendingLogin: null, autoFailover, registryError: null, accounts: [a1, a2] };
    }
    if (method === "account_config") {
      return new Promise((resolve, reject) => {
        releaseConfig = () => {
          if (rejectNextConfig) return reject(Object.assign(new Error("Busy"), { code: "CHROME_BUSY" }));
          autoFailover = Boolean(body?.auto_failover);
          resolve({ autoFailover });
        };
      });
    }
    if (method === "account_switch") {
      return { switched: true, account: { ...a1, active: true } };
    }
    return { ok: true };
  });

  const ui = await createAccountUi(b.bridge, env);
  await ui.openAccountsDialog();
  const toggleEl = els.get("accFailoverToggle")!;
  assert.equal(toggleEl.getAttribute("aria-checked"), "true");
  assert.equal(toggleEl.disabled, false);

  // Pessimistic click locks toggle + sets aria-busy without prematurely flipping aria-checked
  const togglePromise = toggleEl.dispatch("click");
  assert.equal(toggleEl.disabled, true);
  assert.equal(toggleEl.getAttribute("aria-busy"), "true");
  assert.equal(toggleEl.getAttribute("aria-checked"), "true");

  // Click while disabled is ignored
  await toggleEl.dispatch("click");
  releaseConfig(undefined);
  await togglePromise;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(toggleEl.disabled, false);
  assert.equal(toggleEl.getAttribute("aria-busy"), null);
  assert.equal(toggleEl.getAttribute("aria-checked"), "false");
  assert.ok(b.toasts.some((x) => x.msg.includes("Turned off automatic credit failover")));

  // Status poll preserves toggle DOM node identity and updates in place
  ui.onStatus(makeStatus({ activeAccount: a2, activeAccountId: "b1", accounts: [{ ...a1, active: false }, { ...a2, active: true }], autoFailover: true }), false);
  assert.equal(els.get("accFailoverToggle"), toggleEl);
  assert.equal(toggleEl.getAttribute("aria-checked"), "true");

  // Toggle back off then back on to cover toastEnabled
  const toggleOff = toggleEl.dispatch("click");
  releaseConfig(undefined);
  await toggleOff;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(toggleEl.getAttribute("aria-checked"), "false");

  const toggleOn = toggleEl.dispatch("click");
  releaseConfig(undefined);
  await toggleOn;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(toggleEl.getAttribute("aria-checked"), "true");
  assert.ok(b.toasts.some((x) => x.msg.includes("Turned on automatic credit failover")));

  // Error on account_config keeps aria-checked unchanged
  rejectNextConfig = true;
  const errPromise = toggleEl.dispatch("click");
  releaseConfig(undefined);
  await errPromise;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(toggleEl.getAttribute("aria-checked"), "true");
  assert.ok(b.toasts.some((x) => x.bad && x.msg.includes("Busy")));

  // Registry error payload from accounts RPC hides #accFailoverRow cleanly
  const origAccApi = b.bridge.api;
  b.bridge.api = async () => ({ activeAccountId: null, pendingLogin: null, autoFailover: true, registryError: "Corrupt", accounts: [] }) as never;
  await ui.openAccountsDialog();
  assert.equal(els.get("accFailoverRow")!.hidden, true);
  b.bridge.api = origAccApi;

  // Draft switch CTA delegates through account_switch
  await ui.switchDraftAccount("default");
  assert.ok(b.calls.some((c) => c.method === "account_switch" && c.body?.id === "default"));

  // svgIcon passthrough
  assert.ok(ui.svgIcon("x").includes("<svg"));
});

test("bindRollbarHeightSync updates --rollbar-h on ResizeObserver changes and falls back cleanly when absent", async () => {
  const b = makeBridge(async () => ({}));
  const vars = new Map<string, string>();
  const rootStyle = {
    setProperty: (name: string, value: string) => void vars.set(name, value),
  };

  // querySelector returns null -> no error, no var set
  const absentEnv = makeEnv();
  absentEnv.env.doc.querySelector = () => null;
  absentEnv.env.doc.documentElement = { style: rootStyle };
  await createAccountUi(b.bridge, absentEnv.env);
  assert.equal(vars.size, 0);

  // rollbar missing getBoundingClientRect -> no error, no var set
  const noMeasureEnv = makeEnv();
  noMeasureEnv.env.doc.querySelector = () => new MockElement("rollbar");
  noMeasureEnv.env.doc.documentElement = { style: rootStyle };
  await createAccountUi(b.bridge, noMeasureEnv.env);
  assert.equal(vars.size, 0);

  // documentElement absent -> no error, no var set
  const noRootEnv = makeEnv();
  const rollbarNoRoot = new MockElement("rollbar");
  (rollbarNoRoot as ElementLike).getBoundingClientRect = () => ({ height: 112 });
  noRootEnv.env.doc.querySelector = () => rollbarNoRoot;
  await createAccountUi(b.bridge, noRootEnv.env);
  assert.equal(vars.size, 0);

  // height = 0 without ResizeObserver -> ignores non-positive height
  let currentHeight = 0;
  const liveEnv = makeEnv();
  const rollbarEl = new MockElement("rollbar");
  (rollbarEl as ElementLike).getBoundingClientRect = () => ({ height: currentHeight });
  liveEnv.env.doc.querySelector = (sel) => (sel === ".rollbar" ? rollbarEl : null);
  liveEnv.env.doc.documentElement = { style: rootStyle };
  await createAccountUi(b.bridge, liveEnv.env);
  assert.equal(vars.has("--rollbar-h"), false);

  // ResizeObserver present -> initial sync + live resize updates
  const prevResizeObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  const observed: unknown[] = [];
  let triggerResize: (() => void) | null = null;
  class FakeResizeObserver {
    constructor(cb: () => void) {
      triggerResize = cb;
    }
    observe(target: unknown): void {
      observed.push(target);
    }
  }
  try {
    Object.defineProperty(globalThis, "ResizeObserver", { value: FakeResizeObserver, configurable: true });
    currentHeight = 132.4;
    await createAccountUi(b.bridge, liveEnv.env);
    assert.deepEqual(observed, [rollbarEl]);
    assert.equal(vars.get("--rollbar-h"), "133px");

    currentHeight = 96;
    assert.ok(triggerResize);
    (triggerResize as () => void)();
    assert.equal(vars.get("--rollbar-h"), "96px");
  } finally {
    if (prevResizeObserver === undefined) delete (globalThis as Record<string, unknown>).ResizeObserver;
    else Object.defineProperty(globalThis, "ResizeObserver", prevResizeObserver);
  }

  // Verify layout fixes in studio/index.html CSS
  const html = readFileSync(join(process.cwd(), "studio/index.html"), "utf8");
  assert.ok(html.includes(".toast{position:fixed;left:16px;right:16px;bottom:calc(var(--rollbar-h,108px) + 12px);"));
  assert.ok(html.includes("max-width:min(560px,calc(100vw - 32px));margin:0 auto;"));
  assert.ok(html.includes(".job .acc-failover-trail,.job .acc-portable-retry-hint{"));
  assert.ok(html.includes("-webkit-line-clamp:unset;display:block;overflow:visible}"));
  assert.ok(html.includes("padding-bottom:calc(var(--rollbar-h,108px) + 20px)"));
});
