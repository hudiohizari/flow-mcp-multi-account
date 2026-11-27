import {
  ACCOUNT_CONSTANTS,
  normalizeAccountLabel,
  validateAccountLabel,
} from "../shared/account-validation.js";
import { getFailoverPhaseCopy } from "./account-failover.js";
import type {
  AccountActionError,
  AccountItem,
  AccountsViewState,
  DisabledReason,
  FailoverPhaseInfo,
  FlowStatusInfo,
  HeaderStatusModel,
  LocaleCatalog,
  PendingLoginInfo,
  RowControlState,
  StudioBridge,
  StudioJobView,
  StudioStatusPayload,
  Translator,
} from "./account-types.js";
import { preserveAndTagDrafts } from "./draft-guards.js";

export * from "./account-types.js";
export { ACCOUNT_CONSTANTS };

export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => {
    if (c === "&") return "&amp;";
    if (c === "<") return "&lt;";
    if (c === ">") return "&gt;";
    if (c === '"') return "&quot;";
    return "&#39;";
  });
}

const VALIDATION_FORM_KEYS: Record<string, string> = {
  "error.LABEL_EMPTY": "account.form.errorEmpty",
  "error.LABEL_TOO_LONG": "account.form.errorTooLong",
  "error.DUPLICATE_LABEL": "account.form.errorDuplicate",
  "error.LABEL_CONTROL_CHARS": "error.LABEL_CONTROL_CHARS",
};

function walkLocale(obj: unknown, prefix: string, out: LocaleCatalog): LocaleCatalog {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [key, val] of Object.entries(obj)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (typeof val === "string") out[nextKey] = val;
    else walkLocale(val, nextKey, out);
  }
  return out;
}

export function flattenLocale(obj: unknown): LocaleCatalog {
  return walkLocale(obj, "", {});
}

export function createTranslator(catalog: LocaleCatalog): Translator {
  return (key: string, vars?: Record<string, string | number>): string => {
    const base = catalog[key];
    let text = base !== undefined ? base : key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        text = text.replaceAll(`{{${k}}}`, String(v));
      }
    }
    return text;
  };
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export function extractErrorInfo(err: unknown, t: Translator): AccountActionError {
  let code: string | null = null;
  let message = "";
  if (typeof err === "object" && err !== null) {
    const rec = err as { code?: unknown; message?: unknown };
    if (typeof rec.code === "string") code = rec.code;
    if (typeof rec.message === "string") message = rec.message;
  } else if (typeof err === "string") {
    message = err;
  }
  if (message) return { message, code };
  if (code) return { message: t(`error.${code}`), code };
  return { message: t("error.INTERNAL_ERROR"), code: null };
}

export function formatUtcTimestamp(iso: string | undefined, locale: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function validateAccountLabelInput(
  raw: string,
  existingLabels: Iterable<string>,
  t: Translator,
): { ok: true; label: string; length: number } | { ok: false; message: string; length: number } {
  const length = normalizeAccountLabel(raw).length;
  const res = validateAccountLabel(raw, existingLabels);
  if (res.ok) return { ok: true, label: res.label, length };
  return { ok: false, message: t(VALIDATION_FORM_KEYS[res.key], res.vars), length };
}

export function deriveAccountsViewState(
  input: {
    loading: boolean;
    accounts: AccountItem[];
    activeAccountId: string | null;
    pendingLogin: PendingLoginInfo | null;
    registryError: string | null;
    loadError: AccountActionError | null;
    switchInProgress: boolean;
    authInProgress: boolean;
    switchingTargetId: string | null;
    failoverPhase?: FailoverPhaseInfo | null;
  },
  t: Translator,
): AccountsViewState {
  if (input.loading) return { kind: "loading" };
  if (input.registryError !== null) {
    return { kind: "error", message: input.registryError, code: "REGISTRY_CORRUPT", accounts: [], activeAccountId: null };
  }
  if (input.loadError !== null && input.accounts.length === 0) {
    return { kind: "error", message: input.loadError.message, code: input.loadError.code, accounts: [], activeAccountId: null };
  }
  const activeAccount =
    input.accounts.find((a) => a.active) ||
    input.accounts.find((a) => a.id === input.activeAccountId) ||
    input.accounts[0];
  if (!activeAccount) {
    return {
      kind: "error",
      message: t("error.ACCOUNT_NOT_FOUND", { target: input.activeAccountId || t("account.header.noAccount") }),
      code: "ACCOUNT_NOT_FOUND",
      accounts: [],
      activeAccountId: null,
    };
  }
  const phase = input.failoverPhase ?? null;
  if (input.switchInProgress || input.switchingTargetId !== null || phase !== null) {
    return {
      kind: "switching",
      accounts: input.accounts,
      activeAccountId: activeAccount.id,
      targetId: phase?.toAccountId ?? input.switchingTargetId,
      failoverPhase: phase,
    };
  }
  if (input.pendingLogin !== null || input.authInProgress) {
    return { kind: "authInProgress", accounts: input.accounts, activeAccount, pendingLogin: input.pendingLogin };
  }
  if (input.accounts.filter((a) => a.enabled).length <= 1) {
    return { kind: "empty", accounts: input.accounts, activeAccount };
  }
  return { kind: "populated", accounts: input.accounts, activeAccount };
}

export function deriveHeaderStatus(
  input: {
    live: boolean;
    offline: boolean;
    loading: boolean;
    status: StudioStatusPayload | null;
    plan: string | undefined;
    credits: number | undefined;
    switching: boolean;
  },
  t: Translator,
): HeaderStatusModel {
  const st = input.status;
  let tallyClass: HeaderStatusModel["tallyClass"] = "down";
  let statusText = t("account.header.statusConnecting");
  if (!input.live) {
    statusText = t("account.header.statusNotConnected");
  } else if (input.offline) {
    statusText = t("account.header.statusOffline");
  } else if (st) {
    const activeJob = st.jobs.some((j) => j.status === "running" || j.status === "queued");
    if (!st.flow.signedIn || !st.flow.inProject) {
      tallyClass = "down";
      statusText = !st.flow.signedIn ? t("account.header.statusSignedOut") : t("account.header.statusNoProject");
    } else if (activeJob) {
      tallyClass = "rolling";
      statusText = t("account.header.statusWorking");
    } else {
      tallyClass = "ready";
      statusText = t("account.header.statusReady");
    }
  } else {
    tallyClass = "dim";
  }

  const failoverPhase = st && !st.registryError ? (st.failoverPhase ?? null) : null;
  let pillText = t("account.header.pillLoading");
  let pillAria = pillText;
  let pillTitle = "";
  let pillTone: HeaderStatusModel["pillTone"] = "dim";
  if (st && st.registryError) {
    pillText = t("account.header.pillIssue");
    pillAria = pillText;
    pillTone = "down";
  } else if (failoverPhase) {
    const copy = getFailoverPhaseCopy(failoverPhase, t);
    pillText = copy.pillText;
    pillAria = t("account.failover.pillAria", { status: copy.pillText });
    pillTitle = copy.pillText;
    pillTone = "rolling";
  } else if (input.switching || (st && st.switchInProgress)) {
    pillText = t("account.header.pillSwitching");
    pillAria = pillText;
    pillTone = "rolling";
  } else if (!input.loading && st && st.activeAccount) {
    const label = st.activeAccount.label;
    pillText = t("account.header.pillLabel", { label });
    pillAria = t("account.header.pillAria", { label });
    pillTitle = label;
    pillTone = st.flow.authInProgress || st.activeAccount.needsRelogin ? "warn" : "ready";
  }

  const showNewProjectBtn = Boolean(
    input.live &&
    !input.offline &&
    st &&
    !st.registryError &&
    st.flow.signedIn &&
    !st.flow.inProject &&
    !st.flow.authInProgress &&
    !st.switchInProgress &&
    !input.switching &&
    !failoverPhase,
  );

  let hintText: string | null = null;
  if (st) {
    if (st.registryError) hintText = t("hint.registryCorrupt");
    else if (failoverPhase) hintText = getFailoverPhaseCopy(failoverPhase, t).description;
    else if (input.switching || st.switchInProgress) hintText = t("hint.switchInProgress");
    else if (st.flow.hint) hintText = st.flow.hint;
    else if (showNewProjectBtn) hintText = t("hint.noProject");
  }

  return {
    tallyClass,
    statusText,
    plan: input.plan,
    credits: input.credits,
    pillText,
    pillAria,
    pillTitle,
    pillTone,
    hintText,
    showNewProjectBtn,
    failoverPhase,
  };
}

export function deriveRowControls(
  acc: AccountItem,
  index: number,
  total: number,
  enabledCount: number,
  isBusyOrSwitching: boolean,
  t: Translator,
): RowControlState {
  let switchReason: DisabledReason | null = null;
  if (acc.active) switchReason = { id: `acc-reason-switch-${acc.id}`, text: t("account.disabled.activeSwitch") };
  else if (!acc.enabled) switchReason = { id: `acc-reason-switch-${acc.id}`, text: t("account.disabled.disabledSwitch") };
  else if (isBusyOrSwitching) switchReason = { id: `acc-reason-switch-${acc.id}`, text: t("account.disabled.busySwitch") };

  let enableReason: DisabledReason | null = null;
  if (acc.active && acc.enabled) enableReason = { id: `acc-reason-enable-${acc.id}`, text: t("account.disabled.activeDisable") };
  else if (acc.enabled && enabledCount <= 1) enableReason = { id: `acc-reason-enable-${acc.id}`, text: t("account.disabled.soleEnabled") };
  else if (isBusyOrSwitching) enableReason = { id: `acc-reason-enable-${acc.id}`, text: t("account.disabled.busySwitch") };

  let refreshReason: DisabledReason | null = null;
  if (!acc.active) refreshReason = { id: `acc-reason-refresh-${acc.id}`, text: t("account.disabled.inactiveRefresh") };
  else if (isBusyOrSwitching) refreshReason = { id: `acc-reason-refresh-${acc.id}`, text: t("account.disabled.busySwitch") };

  let newProjectReason: DisabledReason | null = null;
  if (!acc.active) newProjectReason = { id: `acc-reason-newproj-${acc.id}`, text: t("account.disabled.inactiveNewProject") };
  else if (isBusyOrSwitching) newProjectReason = { id: `acc-reason-newproj-${acc.id}`, text: t("account.disabled.busySwitch") };

  let moveUpReason: DisabledReason | null = null;
  if (index === 0) moveUpReason = { id: `acc-reason-up-${acc.id}`, text: t("account.disabled.firstPriority") };
  else if (isBusyOrSwitching) moveUpReason = { id: `acc-reason-up-${acc.id}`, text: t("account.disabled.busySwitch") };

  let moveDownReason: DisabledReason | null = null;
  if (index === total - 1) moveDownReason = { id: `acc-reason-down-${acc.id}`, text: t("account.disabled.lastPriority") };
  else if (isBusyOrSwitching) moveDownReason = { id: `acc-reason-down-${acc.id}`, text: t("account.disabled.busySwitch") };

  let removeReason: DisabledReason | null = null;
  if (acc.active) removeReason = { id: `acc-reason-remove-${acc.id}`, text: t("account.disabled.activeRemove") };
  else if (acc.isDefault) removeReason = { id: `acc-reason-remove-${acc.id}`, text: t("account.disabled.defaultRemove") };
  else if (isBusyOrSwitching) removeReason = { id: `acc-reason-remove-${acc.id}`, text: t("account.disabled.busySwitch") };

  return {
    switchDisabled: switchReason !== null,
    switchReason,
    enableDisabled: enableReason !== null,
    enableReason,
    refreshDisabled: refreshReason !== null,
    refreshReason,
    newProjectDisabled: newProjectReason !== null,
    newProjectReason,
    moveUpDisabled: moveUpReason !== null,
    moveUpReason,
    moveDownDisabled: moveDownReason !== null,
    moveDownReason,
    removeDisabled: removeReason !== null,
    removeReason,
    loginDisabled: !acc.enabled || isBusyOrSwitching,
    renameDisabled: isBusyOrSwitching,
  };
}

export function deriveJobRetryState(
  job: StudioJobView,
  activeAccountId: string | null,
  activeAccountLabel: string | null,
): { isRetryable: boolean; blocked: boolean; portableCrossAccount: boolean; jobAccount: string; activeAccount: string } {
  const isRetryable =
    job.status === "failed" ||
    job.status === "cancelled" ||
    (job.status === "done" && Boolean(job.failed_scenes && job.failed_scenes.length > 0));
  const crossAccount =
    isRetryable &&
    Boolean(job.accountId) &&
    Boolean(activeAccountId) &&
    job.accountId !== activeAccountId;
  const blocked = crossAccount && job.portable !== true;
  const portableCrossAccount = crossAccount && job.portable === true;
  return {
    isRetryable,
    blocked,
    portableCrossAccount,
    jobAccount: job.accountLabel || job.accountId || "",
    activeAccount: activeAccountLabel || activeAccountId || "",
  };
}

export function detectAccountChange(params: {
  sessionAccountId: string | null;
  persistedAccountId: string | null;
  nextAccountId: string | null;
  prevPending: PendingLoginInfo | null;
  nextPending: PendingLoginInfo | null;
  accounts: AccountItem[];
}): { changed: boolean; revertedLabel: string | null } {
  const { sessionAccountId, persistedAccountId, nextAccountId, prevPending, nextPending, accounts } = params;
  if (!nextAccountId) return { changed: false, revertedLabel: null };
  const baseline = sessionAccountId !== null ? sessionAccountId : persistedAccountId;
  const changed = baseline !== null && baseline !== nextAccountId;
  const reverted = Boolean(prevPending && !nextPending && nextAccountId === prevPending.previousAccountId);
  const found = reverted ? accounts.find((a) => a.id === nextAccountId) : undefined;
  return { changed, revertedLabel: found ? found.label : null };
}

export function shouldPollDetailed(prevFlow: FlowStatusInfo | null, nextFlow: FlowStatusInfo, wasDetailed: boolean): boolean {
  if (wasDetailed || !nextFlow.signedIn) return false;
  if (!prevFlow) return true;
  return !prevFlow.signedIn || (!prevFlow.inProject && nextFlow.inProject);
}

export function resetStaleStudioState(
  bridge: Pick<
    StudioBridge,
    "getStudioState" | "getCastImage" | "saveStudioState" | "clearLib" | "clearAssetPickers" | "clearCast" | "renderAll"
  >,
  prevAccount?: { id: string; label?: string } | null,
): { preservedAssets: number } {
  bridge.clearLib();
  bridge.clearAssetPickers();
  bridge.clearCast();
  const res = preserveAndTagDrafts(bridge.getStudioState(), bridge.getCastImage(), prevAccount ?? null);
  bridge.saveStudioState();
  bridge.renderAll();
  return res;
}
