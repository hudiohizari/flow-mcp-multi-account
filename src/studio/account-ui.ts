import { STATIC_ROUTES } from "../shared/routes.js";
import { createRowActionsController } from "./account-actions.js";
import { bindAddAccountForm, bindNewProjectDialog, bindTrashDialog, getRequiredEl } from "./account-dialogs.js";
import { syncFailoverControl } from "./account-failover.js";
import { esc, renderAccountList, renderActionAlert, renderDraftMismatchBanner, renderHeaderPills, renderHintBox, renderMonitorJobs, renderStateBanner, svgIcon } from "./account-render.js";
import { createTranslator, deriveAccountsViewState, deriveHeaderStatus, detectAccountChange, extractErrorInfo, flattenLocale, isAbortError, resetStaleStudioState, shouldPollDetailed } from "./account-state.js";
import type { AccountActionError, AccountItem, AccountsPayload, AccountUiController, AccountUiEnv, DocumentLike, FlowStatusInfo, InFlightAccountOp, PendingLoginInfo, StudioBridge, StudioSlotRef, StudioStatusPayload } from "./account-types.js";
import { clearMismatchedOnSurface, deriveActiveTabRollBlock, deriveCastImageMismatch, deriveSurfaceMismatch, getSlotDisplayInfo, stampSlotAccount } from "./draft-guards.js";

const LAST_ACCOUNT_KEY = "lastAccountId";
const LAST_ACCOUNT_LABEL_KEY = "lastAccountLabel";

function bindRollbarHeightSync(doc: DocumentLike): void {
  const rollbar = doc.querySelector?.(".rollbar");
  const rootStyle = doc.documentElement?.style;
  if (!rollbar?.getBoundingClientRect || !rootStyle) return;
  const measure = rollbar.getBoundingClientRect.bind(rollbar);
  const update = (): void => {
    const height = Math.ceil(measure().height);
    if (height > 0) rootStyle.setProperty("--rollbar-h", `${height}px`);
  };
  update();
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(update).observe(rollbar as unknown as Element);
  }
}

export async function createAccountUi(bridge: StudioBridge, env: AccountUiEnv): Promise<AccountUiController> {
  let catalog = {};
  try {
    const res = await env.fetchFn(STATIC_ROUTES.LOCALE_EN);
    if (res.ok) catalog = flattenLocale(await res.json());
    else console.warn(`Failed to load locale ${STATIC_ROUTES.LOCALE_EN}: HTTP ${res.status}`);
  } catch (err) {
    console.warn(`Failed to load locale ${STATIC_ROUTES.LOCALE_EN}:`, err);
    catalog = {};
  }
  const t = createTranslator(catalog);

  const statusEl = getRequiredEl(env.doc, "status");
  const hintEl = getRequiredEl(env.doc, "hint");
  const jobsEl = getRequiredEl(env.doc, "jobs");
  const accountsDialog = getRequiredEl(env.doc, "accountsDialog");
  const accBannerEl = getRequiredEl(env.doc, "accStateBanner");
  const accAlertEl = getRequiredEl(env.doc, "accActionAlert");
  const accToolbarEl = getRequiredEl(env.doc, "accToolbar");
  const accAddToggleBtn = getRequiredEl(env.doc, "accAddToggle");
  const accFailoverRow = getRequiredEl(env.doc, "accFailoverRow");
  const accFailoverToggle = getRequiredEl(env.doc, "accFailoverToggle");
  const accFailoverEmptyNote = getRequiredEl(env.doc, "accFailoverEmptyNote");
  const accFailoverLockReason = getRequiredEl(env.doc, "accFailoverLockReason");
  const accListEl = getRequiredEl(env.doc, "accList");
  const closeBtn = getRequiredEl(env.doc, "accDialogClose");

  getRequiredEl(env.doc, "accDialogTitle").textContent = t("account.dialog.title");
  getRequiredEl(env.doc, "accDialogSubtitle").textContent = t("account.dialog.subtitle");
  getRequiredEl(env.doc, "accFailoverLabel").textContent = t("account.failover.toggleLabel");
  getRequiredEl(env.doc, "accFailoverHelper").textContent = t("account.failover.helper");
  accFailoverEmptyNote.innerHTML = `<strong>${esc(t("account.failover.emptyHeading"))}</strong> <span>${esc(t("account.failover.emptyHint"))}</span>`;
  closeBtn.setAttribute("aria-label", t("account.dialog.close"));
  closeBtn.innerHTML = svgIcon("x");

  let loading = true;
  let accounts: AccountItem[] = [];
  let activeAccountId: string | null = null;
  let activeAccountLabel: string | null = null;
  let autoFailover = true;
  let pendingLogin: PendingLoginInfo | null = null;
  let registryError: string | null = null;
  let loadError: AccountActionError | null = null;
  let actionError: AccountActionError | null = null;
  let lastStatus: StudioStatusPayload | null = null;
  let prevFlow: FlowStatusInfo | null = null;
  let headerPlan: string | undefined;
  let headerCredits: number | undefined;
  let switchInProgress = false;
  let switchingTargetId: string | null = null;
  let inFlight: InFlightAccountOp | null = null;
  let accountEpoch = 0;
  let accountAbort = new AbortController();
  let fetchAbort: AbortController | null = null;
  let renaming = { id: null as string | null, draft: "", touched: false, error: null as string | null };
  let addFormApi!: { setOpen: (open: boolean) => void; isOpen: () => boolean };

  const isEditingAccountForm = (): boolean => Boolean(accountsDialog.open && (renaming.id !== null || addFormApi.isOpen()));

  const renderHeader = (live: boolean, offline: boolean): void => {
    const model = deriveHeaderStatus(
      { live, offline, loading, status: lastStatus, plan: headerPlan, credits: headerCredits, switching: switchingTargetId !== null },
      t,
    );
    statusEl.innerHTML = renderHeaderPills(model, t);
    hintEl.innerHTML = renderHintBox(model.hintText, model.showNewProjectBtn, t, model.failoverPhase);
  };

  const renderDialog = (fromPoll: boolean): void => {
    if (fromPoll && isEditingAccountForm()) return;
    const view = deriveAccountsViewState(
      {
        loading,
        accounts,
        activeAccountId,
        pendingLogin,
        registryError,
        loadError,
        switchInProgress,
        authInProgress: Boolean(lastStatus && lastStatus.flow.authInProgress),
        switchingTargetId,
        failoverPhase: lastStatus?.failoverPhase ?? null,
      },
      t,
    );
    const busy = Boolean(lastStatus && lastStatus.busy);
    const enabledCount = accounts.filter((a) => a.enabled).length;
    accBannerEl.innerHTML = renderStateBanner(view, t);
    accAlertEl.innerHTML = renderActionAlert(actionError, t);
    accToolbarEl.hidden = view.kind === "loading" || view.kind === "error" || view.kind === "switching";
    accAddToggleBtn.setAttribute("aria-expanded", String(addFormApi.isOpen()));
    syncFailoverControl(
      { row: accFailoverRow, toggle: accFailoverToggle, emptyNote: accFailoverEmptyNote, lockReason: accFailoverLockReason },
      { view, autoFailover, enabledCount, busy, inFlight, t },
    );
    accListEl.setAttribute("aria-busy", String(view.kind === "loading"));
    accListEl.innerHTML = renderAccountList({
      view,
      renamingId: renaming.id,
      renameDraft: renaming.draft,
      renameError: renaming.error,
      inFlight,
      busy,
      locale: env.locale,
      nowMs: env.nowMs(),
      t,
    });
  };

  addFormApi = bindAddAccountForm({
    env,
    bridge,
    t,
    getAccounts: () => accounts,
    onOpenChange: (open) => {
      if (open) renaming = { id: null, draft: "", touched: false, error: null };
      renderDialog(false);
    },
    onAdded: async (nextAccounts) => {
      accounts = nextAccounts;
      renderDialog(false);
      await bridge.triggerPoll(false);
    },
  });

  const trashApi = bindTrashDialog({
    env,
    bridge,
    t,
    onRemoved: async (nextAccounts) => {
      accounts = nextAccounts;
      renderDialog(false);
      await bridge.triggerPoll(false);
    },
    onError: (err) => {
      actionError = err;
      renderDialog(false);
    },
  });

  const newProjectApi = bindNewProjectDialog({ env, bridge, t });

  const refreshAccounts = async (): Promise<void> => {
    if (!bridge.isLive()) {
      loading = false;
      loadError = { message: t("error.REMOTE_UNREACHABLE"), code: "REMOTE_UNREACHABLE" };
      renderDialog(false);
      return;
    }
    if (fetchAbort) fetchAbort.abort();
    fetchAbort = new AbortController();
    try {
      const data = await bridge.api<AccountsPayload>("accounts", {}, { signal: fetchAbort.signal });
      accounts = data.accounts;
      activeAccountId = data.activeAccountId;
      activeAccountLabel = data.accounts.find((a) => a.id === data.activeAccountId)?.label ?? null;
      if (data.autoFailover !== undefined) autoFailover = data.autoFailover;
      pendingLogin = data.pendingLogin;
      registryError = data.registryError;
      loading = false;
      loadError = null;
      actionError = null;
      renderDialog(false);
    } catch (err) {
      if (isAbortError(err)) return;
      loading = false;
      loadError = extractErrorInfo(err, t);
      renderDialog(false);
    }
  };

  const openAccountsDialog = async (): Promise<void> => {
    if (accounts.length === 0 && registryError === null) loading = true;
    renderDialog(false);
    accountsDialog.showModal();
    await refreshAccounts();
  };

  const runRowAction = async (kind: InFlightAccountOp["kind"], id: string | null, fn: () => Promise<void>): Promise<void> => {
    if (inFlight !== null || !bridge.guard()) return;
    inFlight = { kind, id };
    if (kind === "switch") {
      switchingTargetId = id;
      renderHeader(bridge.isLive(), false);
    }
    actionError = null;
    renderDialog(false);
    try {
      await fn();
    } catch (err) {
      const info = extractErrorInfo(err, t);
      actionError = info;
      bridge.toast(info.message, true);
    } finally {
      inFlight = null;
      switchingTargetId = null;
      renderHeader(bridge.isLive(), false);
      renderDialog(false);
    }
  };

  const rowActions = createRowActionsController({
    env,
    bridge,
    t,
    getAccounts: () => accounts,
    setAccounts: (next) => { accounts = next; },
    getAutoFailover: () => autoFailover,
    setAutoFailover: (val) => { autoFailover = val; },
    setRenaming: (next) => { renaming = next; },
    getRenaming: () => renaming,
    closeAddPanel: () => addFormApi.setOpen(false),
    openNewProject: newProjectApi.open,
    openTrash: trashApi.open,
    runRowAction,
    renderDialog: () => renderDialog(false),
  });

  rowActions.bindListListeners(accListEl);
  accFailoverToggle.addEventListener("click", () => { if (!accFailoverToggle.disabled) void rowActions.handleFailoverToggle(); });
  statusEl.addEventListener("click", (e) => { if (e.target.closest("#accountPill")) void openAccountsDialog(); });
  hintEl.addEventListener("click", (e) => { if (e.target.closest("#newProjectBtn")) newProjectApi.open(); });
  jobsEl.addEventListener("click", async (e) => {
    if (e.target.closest("[data-open-accounts]")) return void openAccountsDialog();
    const r = e.target.closest("[data-retry]");
    const c = e.target.closest("[data-cancel]");
    if (!r && !c) return;
    try {
      if (r) await bridge.api("retry", { job_ids: [r.getAttribute("data-retry")!] });
      else await bridge.api("cancel", { job_id: c!.getAttribute("data-cancel")! });
      await bridge.triggerPoll(false);
    } catch (err) {
      bridge.toast(extractErrorInfo(err, t).message, true);
    }
  });
  closeBtn.addEventListener("click", () => accountsDialog.close());

  accountsDialog.addEventListener("click", (e) => {
    const bannerAct = e.target.closest("[data-acc-banner-action]");
    if (bannerAct) {
      const act = bannerAct.getAttribute("data-acc-banner-action");
      if (act === "new-project") newProjectApi.open();
      else if (act === "login" && activeAccountId) void rowActions.handleRowClick("login", activeAccountId);
      else {
        actionError = null;
        void refreshAccounts();
        void bridge.triggerPoll(true);
      }
      return;
    }
    const rowBtn = e.target.closest("[data-acc-action]");
    if (rowBtn) void rowActions.handleRowClick(rowBtn.getAttribute("data-acc-action")!, rowBtn.getAttribute("data-id")!);
  });

  renderHeader(bridge.isLive(), false);
  bindRollbarHeightSync(env.doc);

  return {
    t,
    svgIcon,
    isEditingAccountForm,
    getAccountEpoch: () => accountEpoch,
    getAccountSignal: () => accountAbort.signal,
    openAccountsDialog,
    openNewProjectDialog: newProjectApi.open,
    renderOffline: (live: boolean) => renderHeader(live, true),
    renderJobs: (st: StudioStatusPayload) =>
      renderMonitorJobs([...st.jobs].reverse(), st.activeAccountId, st.activeAccount ? st.activeAccount.label : null, bridge.media, t, st.failoverPhase ?? null),
    stampSlot: (slot: StudioSlotRef | null) =>
      stampSlotAccount(slot, activeAccountId ? { id: activeAccountId, label: activeAccountLabel ?? undefined } : null),
    getSlotView: (slot: StudioSlotRef | null) => getSlotDisplayInfo(slot, activeAccountId, t),
    renderDraftBanner: (surface) => {
      const st = bridge.getStudioState();
      return renderDraftMismatchBanner(surface, deriveSurfaceMismatch(surface, st, bridge.getCastImage(), activeAccountId, activeAccountLabel, t), st.frames.engine === "agent", t);
    },
    clearMismatchedDrafts: (surface) => {
      bridge.setCastImage(clearMismatchedOnSurface(surface, bridge.getStudioState(), bridge.getCastImage(), activeAccountId));
      bridge.saveStudioState();
      bridge.renderAll();
    },
    switchDraftAccount: (accountId: string) => rowActions.switchToAccount(accountId),
    getRollBlock: () => {
      const st = bridge.getStudioState();
      return deriveActiveTabRollBlock(st.tab, st, activeAccountId, activeAccountLabel, t);
    },
    getCastBlock: () => deriveCastImageMismatch(bridge.getCastImage(), activeAccountId, activeAccountLabel, t),
    onStatus: (st: StudioStatusPayload, detailed: boolean) => {
      const persisted = env.storage.getItem(LAST_ACCOUNT_KEY);
      const prevId = activeAccountId !== null ? activeAccountId : persisted;
      const prevLabel = prevId
        ? (accounts.find((a) => a.id === prevId)?.label ?? st.accounts.find((a) => a.id === prevId)?.label ?? env.storage.getItem(LAST_ACCOUNT_LABEL_KEY) ?? undefined)
        : undefined;
      const prevAccount = prevId ? { id: prevId, label: prevLabel } : null;
      const hadActiveId = activeAccountId !== null;
      const change = detectAccountChange({
        sessionAccountId: activeAccountId,
        persistedAccountId: persisted,
        nextAccountId: st.activeAccountId,
        prevPending: pendingLogin,
        nextPending: st.pendingLogin,
        accounts: st.accounts,
      });

      accounts = st.accounts;
      activeAccountId = st.activeAccountId;
      activeAccountLabel = st.activeAccount ? st.activeAccount.label : null;
      if (st.autoFailover !== undefined) autoFailover = st.autoFailover;
      pendingLogin = st.pendingLogin;
      registryError = st.registryError;
      switchInProgress = st.switchInProgress;
      loading = false;
      loadError = null;
      lastStatus = st;

      if (change.changed && st.activeAccountId) {
        accountEpoch++;
        accountAbort.abort();
        accountAbort = new AbortController();
        headerPlan = undefined;
        headerCredits = undefined;
        const { preservedAssets } = resetStaleStudioState(bridge, prevAccount);
        env.storage.setItem(LAST_ACCOUNT_KEY, st.activeAccountId);
        if (st.activeAccount) env.storage.setItem(LAST_ACCOUNT_LABEL_KEY, st.activeAccount.label);
        void bridge.reloadCast(accountAbort.signal, accountEpoch);
        if (change.revertedLabel) bridge.toast(t("account.toast.loginReverted", { previousLabel: change.revertedLabel }));
        else if (st.activeAccount) bridge.toast(t(preservedAssets > 0 ? "account.failover.switchedPreserved" : "hint.staleCleared", { label: st.activeAccount.label }));
      } else if (st.activeAccountId) {
        if (persisted === null) env.storage.setItem(LAST_ACCOUNT_KEY, st.activeAccountId);
        if (st.activeAccount) env.storage.setItem(LAST_ACCOUNT_LABEL_KEY, st.activeAccount.label);
        if (!hadActiveId) bridge.renderAll();
      }

      if (st.flow.credits_remaining !== undefined) headerCredits = st.flow.credits_remaining;
      if (st.flow.plan) headerPlan = st.flow.plan;
      bridge.setSwitchBusy(Boolean(st.switchInProgress));

      const shouldDetailed = shouldPollDetailed(prevFlow, st.flow, detailed);
      prevFlow = st.flow;

      renderHeader(true, false);
      if (accountsDialog.open) renderDialog(true);
      if (shouldDetailed) void bridge.triggerPoll(true);
    },
  };
}

export function initAccountUi(bridge: StudioBridge, customEnv?: AccountUiEnv): Promise<AccountUiController> {
  const env: AccountUiEnv = customEnv !== undefined
    ? customEnv
    : {
        doc: document as unknown as DocumentLike,
        storage: localStorage,
        fetchFn: (input, init) => fetch(input, init),
        locale: navigator.language || "en",
        nowMs: () => Date.now(),
      };
  return createAccountUi(bridge, env);
}
