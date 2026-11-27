import { ACCOUNT_CONSTANTS, normalizeAccountLabel } from "../shared/account-validation.js";
import { deriveAccountCreditMeta, formatFailoverTrail, getFailoverPhaseCopy } from "./account-failover.js";
import {
  deriveJobRetryState,
  deriveRowControls,
  esc,
  formatUtcTimestamp,
  type AccountActionError,
  type AccountItem,
  type AccountsViewState,
  type DisabledReason,
  type FailoverPhaseInfo,
  type HeaderStatusModel,
  type InFlightAccountOp,
  type StudioJobView,
  type SvgIconName,
  type Translator,
} from "./account-state.js";
import type { DraftSurfaceMismatch } from "./draft-guards.js";

export { esc, type SvgIconName };

const SVG_PATHS: Record<SvgIconName, string> = {
  "user-circle": '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="10" r="3"/><path d="M6.8 18.8a6.5 6.5 0 0 1 10.4 0"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  "arrow-up": '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>',
  "arrow-down": '<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  "folder-plus": '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M12 11v6"/><path d="M9 14h6"/>',
  "log-in": '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  "alert-triangle": '<path d="m10.29 3.86-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.71-3l-8-14a2 2 0 0 0-3.42 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
};

export function svgIcon(name: SvgIconName): string {
  return `<svg class="acc-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SVG_PATHS[name]}</svg>`;
}

export function renderHeaderPills(model: HeaderStatusModel, t: Translator): string {
  const planPill = model.plan ? `<span class="pill">${esc(model.plan)}</span>` : "";
  const creditsPill =
    model.credits !== undefined
      ? `<span class="pill tabular">${esc(t("account.header.creditsValue", { count: model.credits.toLocaleString() }))}</span>`
      : "";
  const titleAttr = model.pillTitle ? ` title="${esc(model.pillTitle)}"` : "";
  return `<span class="pill"><i class="tally ${model.tallyClass}"></i>${esc(model.statusText)}</span>${planPill}${creditsPill}<button type="button" id="accountPill" class="pill account-pill" aria-label="${esc(model.pillAria)}"${titleAttr}><i class="tally ${model.pillTone}"></i>${svgIcon("user-circle")}<span class="account-pill-label">${esc(model.pillText)}</span></button>`;
}

export function renderHintBox(
  hintText: string | null,
  showNewProjectBtn: boolean,
  t: Translator,
  failoverPhase?: FailoverPhaseInfo | null,
): string {
  if (!hintText && !showNewProjectBtn && !failoverPhase) return "";
  let textHtml = hintText ? `<span>${esc(hintText)}</span>` : "";
  if (failoverPhase) {
    const copy = getFailoverPhaseCopy(failoverPhase, t);
    textHtml = `<div class="acc-hint-failover">${svgIcon("refresh")}<div><strong>${esc(copy.heading)}</strong><p>${esc(copy.description)}</p></div></div>`;
  }
  const btnHtml = showNewProjectBtn
    ? `<button type="button" id="newProjectBtn" class="btn small acc-btn-primary">${svgIcon("folder-plus")}<span>${esc(t("account.actions.newProject"))}</span></button>`
    : "";
  return `<div class="hint acc-hint-box">${textHtml}${btnHtml}</div>`;
}

export function renderStateBanner(view: AccountsViewState, t: Translator): string {
  if (view.kind === "loading") {
    return `<div class="acc-banner" role="status"><h3>${esc(t("account.states.loading.heading"))}</h3><p>${esc(t("account.states.loading.description"))}</p></div>`;
  }
  if (view.kind === "error") {
    return `<div class="acc-banner acc-banner-error" role="alert"><div class="acc-banner-head">${svgIcon("alert-triangle")}<h3>${esc(t("account.states.error.heading"))}</h3></div><p>${esc(t("account.states.error.description"))}</p><p class="acc-error-detail">${esc(view.message)}</p><div class="acc-banner-actions"><button type="button" class="btn small" data-acc-banner-action="retry">${svgIcon("refresh")}<span>${esc(t("account.actions.retry"))}</span></button></div></div>`;
  }
  if (view.kind === "switching") {
    if (view.failoverPhase) {
      const copy = getFailoverPhaseCopy(view.failoverPhase, t);
      return `<div class="acc-banner acc-banner-warn" role="status"><div class="acc-banner-head">${svgIcon("refresh")}<h3>${esc(copy.heading)}</h3></div><p>${esc(copy.description)}</p></div>`;
    }
    return `<div class="acc-banner acc-banner-warn" role="status"><h3>${esc(t("account.states.switching.heading"))}</h3><p>${esc(t("account.states.switching.description"))}</p></div>`;
  }
  if (view.kind === "authInProgress") {
    return `<div class="acc-banner acc-banner-warn" role="status"><div class="acc-banner-head">${svgIcon("alert-triangle")}<h3>${esc(t("account.badges.needsSignIn"))}</h3></div><p>${esc(t("hint.authInProgress"))}</p></div>`;
  }
  if (view.kind === "empty") {
    return `<div class="acc-banner" role="status"><h3>${esc(t("account.states.empty.heading"))}</h3><p>${esc(t("account.states.empty.description"))}</p></div>`;
  }
  return `<div class="acc-banner" role="status"><h3>${esc(t("account.states.populated.heading"))}</h3><p>${esc(t("account.states.populated.description"))}</p></div>`;
}

export function renderActionAlert(error: AccountActionError | null, t: Translator): string {
  if (!error) return "";
  let action = "retry";
  let iconName: SvgIconName = "refresh";
  let label = t("account.actions.retry");
  if (error.code === "AUTH_REQUIRED" || error.code === "PROFILE_MISSING") {
    action = "login";
    iconName = "log-in";
    label = t("account.actions.signIn");
  } else if (error.code === "NOT_IN_PROJECT") {
    action = "new-project";
    iconName = "folder-plus";
    label = t("account.actions.newProject");
  }
  return `<div class="acc-banner acc-banner-error" role="alert"><div class="acc-banner-head">${svgIcon("alert-triangle")}<p>${esc(error.message)}</p></div><div class="acc-banner-actions"><button type="button" class="btn small" data-acc-banner-action="${action}">${svgIcon(iconName)}<span>${esc(label)}</span></button></div></div>`;
}

function renderBadges(acc: AccountItem, isSwitchingThis: boolean, creditBadge: string | null, t: Translator): string {
  const badges: string[] = [];
  if (acc.active) badges.push(`<span class="acc-badge acc-badge-active">${esc(t("account.badges.active"))}</span>`);
  if (acc.isDefault) badges.push(`<span class="acc-badge acc-badge-primary">${esc(t("account.badges.primary"))}</span>`);
  if (!acc.enabled) badges.push(`<span class="acc-badge acc-badge-disabled">${esc(t("account.badges.disabled"))}</span>`);
  if (acc.needsRelogin) badges.push(`<span class="acc-badge acc-badge-warn">${esc(t("account.badges.needsSignIn"))}</span>`);
  if (creditBadge) badges.push(`<span class="acc-badge acc-badge-warn">${esc(creditBadge)}</span>`);
  if (isSwitchingThis) badges.push(`<span class="acc-badge acc-badge-tally">${esc(t("account.badges.switching"))}</span>`);
  return badges.join("");
}

function renderRenameForm(
  acc: AccountItem,
  renameDraft: string,
  renameError: string | null,
  saving: boolean,
  t: Translator,
): string {
  const len = normalizeAccountLabel(renameDraft).length;
  const countId = `accRenameCount-${esc(acc.id)}`;
  const errId = `accRenameErr-${esc(acc.id)}`;
  const describedBy = renameError ? `${countId} ${errId}` : countId;
  return `<form class="acc-rename-form" data-acc-rename-form="${esc(acc.id)}" novalidate>
    <label class="f" for="accRenameInput-${esc(acc.id)}">${esc(t("account.form.renameLabel"))}</label>
    <div class="acc-input-row">
      <input id="accRenameInput-${esc(acc.id)}" data-acc-rename-input="${esc(acc.id)}" type="text" maxlength="${ACCOUNT_CONSTANTS.LABEL_MAX}" value="${esc(renameDraft)}" placeholder="${esc(t("account.form.renamePlaceholder"))}" autocomplete="off" aria-invalid="${renameError ? "true" : "false"}" aria-describedby="${describedBy}">
      <span id="${countId}" class="acc-counter tabular${len > ACCOUNT_CONSTANTS.LABEL_MAX ? " over" : ""}">${len}/${ACCOUNT_CONSTANTS.LABEL_MAX}</span>
    </div>
    <p id="${errId}" class="acc-field-error"${renameError ? "" : " hidden"}>${renameError ? `${svgIcon("alert-triangle")}<span>${esc(renameError)}</span>` : ""}</p>
    <div class="acc-form-actions">
      <button type="submit" class="btn small acc-btn-primary"${saving ? ' disabled aria-busy="true"' : ""}>${esc(t(saving ? "account.actions.saving" : "account.actions.save"))}</button>
      <button type="button" class="btn small ghost" data-acc-action="cancel-rename" data-id="${esc(acc.id)}"${saving ? " disabled" : ""}>${esc(t("account.actions.cancel"))}</button>
    </div>
  </form>`;
}

function collectUniqueReasons(
  reasons: (DisabledReason | null)[],
  idByText: Map<string, string>,
): DisabledReason[] {
  const unique: DisabledReason[] = [];
  for (const reason of reasons) {
    if (reason && !idByText.has(reason.text)) {
      idByText.set(reason.text, reason.id);
      unique.push(reason);
    }
  }
  return unique;
}

export function renderAccountList(opts: {
  view: AccountsViewState;
  renamingId: string | null;
  renameDraft: string;
  renameError: string | null;
  inFlight: InFlightAccountOp | null;
  busy: boolean;
  locale: string;
  nowMs: number;
  t: Translator;
}): string {
  const { view, renamingId, renameDraft, renameError, inFlight, busy, locale, nowMs, t } = opts;
  if (view.kind === "loading") {
    return `<li class="acc-skel" aria-hidden="true"><div class="acc-skel-bar"></div><div class="acc-skel-grid"><span></span><span></span><span></span><span></span></div></li><li class="acc-skel" aria-hidden="true"><div class="acc-skel-bar"></div><div class="acc-skel-grid"><span></span><span></span><span></span><span></span></div></li>`;
  }
  if (view.kind === "error") return "";

  const list = view.accounts;
  const enabledCount = list.filter((a) => a.enabled).length;
  const locked = view.kind === "switching" || busy || inFlight !== null;

  return list
    .map((acc, index) => {
      const ctrl = deriveRowControls(acc, index, list.length, enabledCount, locked, t);
      const isSwitchingThis =
        (view.kind === "switching" && view.targetId === acc.id) ||
        (inFlight !== null && inFlight.kind === "switch" && inFlight.id === acc.id);
      const isRefreshingThis = inFlight !== null && inFlight.kind === "refresh" && inFlight.id === acc.id;
      const isCreatingProj = inFlight !== null && inFlight.kind === "newProject" && inFlight.id === acc.id;
      const isSavingRename = inFlight !== null && inFlight.kind === "rename" && inFlight.id === acc.id;

      const updated = formatUtcTimestamp(acc.balanceUpdatedAt, locale);
      const creditsText =
        acc.creditsRemaining !== undefined ? acc.creditsRemaining.toLocaleString() : t("account.meta.unrecorded");
      const creditMeta = deriveAccountCreditMeta(acc, nowMs, t);
      const planText = acc.plan || t("account.meta.unrecorded");
      const updatedText = updated ? t("account.meta.updatedAt", { time: updated }) : t("account.meta.unrecorded");
      const projectText = acc.lastProjectTitle || acc.lastProjectUrl || t("account.meta.noProjectOpen");

      const reasonIdByText = new Map<string, string>();
      const visibleReasons = collectUniqueReasons(
        [ctrl.switchReason, ctrl.enableReason, ctrl.refreshReason, ctrl.newProjectReason, ctrl.removeReason],
        reasonIdByText,
      );
      const hiddenReasons = collectUniqueReasons([ctrl.moveUpReason, ctrl.moveDownReason], reasonIdByText);

      const reasonsHtml = `<div class="acc-reasons">${visibleReasons.map((r) => `<span id="${esc(r.id)}" class="acc-reason">${esc(r.text)}</span>`).join("")}${hiddenReasons.map((r) => `<span id="${esc(r.id)}" class="visually-hidden">${esc(r.text)}</span>`).join("")}</div>`;

      return `<li class="acc-row" data-account-id="${esc(acc.id)}" data-active="${String(acc.active)}">
        <div class="acc-row-head">
          <span class="acc-rank tabular" aria-label="${esc(t("account.meta.priority", { rank: acc.priority }))}">#${acc.priority}</span>
          <strong id="acc-name-${esc(acc.id)}" class="acc-label">${esc(acc.label)}</strong>
          <div class="acc-badges">${renderBadges(acc, isSwitchingThis, creditMeta.badgeText, t)}</div>
          <div class="acc-toggle">
            <span id="acc-toggle-lbl-${esc(acc.id)}" class="acc-toggle-label">${esc(t("account.meta.enabledToggle"))}</span>
            <button type="button" role="switch" class="acc-switch" aria-checked="${String(acc.enabled)}" aria-labelledby="acc-toggle-lbl-${esc(acc.id)} acc-name-${esc(acc.id)}" data-acc-action="toggle" data-id="${esc(acc.id)}"${ctrl.enableDisabled ? ` disabled aria-describedby="${esc(reasonIdByText.get(ctrl.enableReason!.text)!)}"` : ""}><span class="acc-switch-track"><span class="acc-switch-thumb"></span></span></button>
          </div>
        </div>
        <div class="acc-meta">
          <div><span>${esc(t("account.meta.plan"))}</span><strong>${esc(planText)}</strong></div>
          <div><span>${esc(t("account.meta.credits"))}</span><strong class="tabular">${esc(creditsText)}</strong>${creditMeta.ttlNote ? `<span class="acc-meta-ttl">${esc(creditMeta.ttlNote)}</span>` : ""}</div>
          <div><span>${esc(t("account.meta.updated"))}</span><strong class="tabular">${esc(updatedText)}</strong></div>
          <div><span>${esc(t("account.meta.project"))}</span><strong class="acc-project-val">${esc(projectText)}</strong></div>
          ${creditMeta.detailText ? `<div class="acc-meta-detail"><span>${esc(t("account.meta.failover"))}</span><p>${esc(creditMeta.detailText)}</p></div>` : ""}
        </div>
        <div class="acc-tier3">
          <div class="acc-actions">
            <button type="button" class="btn small acc-btn-primary" data-acc-action="switch" data-id="${esc(acc.id)}"${ctrl.switchDisabled ? ` disabled aria-describedby="${esc(reasonIdByText.get(ctrl.switchReason!.text)!)}"` : ""}>${svgIcon(acc.active ? "check" : "log-in")}<span>${esc(t(isSwitchingThis ? "account.actions.switching" : "account.actions.switch"))}</span></button>
            <button type="button" class="btn small ghost" data-acc-action="login" data-id="${esc(acc.id)}"${ctrl.loginDisabled ? " disabled" : ""}>${svgIcon("user-circle")}<span>${esc(t("account.actions.signIn"))}</span></button>
            <button type="button" class="btn small ghost" data-acc-action="refresh" data-id="${esc(acc.id)}"${ctrl.refreshDisabled ? ` disabled aria-describedby="${esc(reasonIdByText.get(ctrl.refreshReason!.text)!)}"` : ""}>${svgIcon("refresh")}<span>${esc(t(isRefreshingThis ? "account.actions.refreshing" : "account.actions.refresh"))}</span></button>
            <button type="button" class="btn small ghost" data-acc-action="new-project" data-id="${esc(acc.id)}"${ctrl.newProjectDisabled ? ` disabled aria-describedby="${esc(reasonIdByText.get(ctrl.newProjectReason!.text)!)}"` : ""}>${svgIcon("folder-plus")}<span>${esc(t(isCreatingProj ? "account.actions.creatingProject" : "account.actions.newProject"))}</span></button>
            <button type="button" class="btn small ghost" data-acc-action="rename" data-id="${esc(acc.id)}"${ctrl.renameDisabled ? " disabled" : ""}>${svgIcon("pencil")}<span>${esc(t("account.actions.rename"))}</span></button>
            <button type="button" class="btn small ghost acc-icon-btn" data-acc-action="move-up" data-id="${esc(acc.id)}" aria-label="${esc(t("account.actions.moveUpAria", { label: acc.label }))}"${ctrl.moveUpDisabled ? ` disabled aria-describedby="${esc(reasonIdByText.get(ctrl.moveUpReason!.text)!)}"` : ""}>${svgIcon("arrow-up")}</button>
            <button type="button" class="btn small ghost acc-icon-btn" data-acc-action="move-down" data-id="${esc(acc.id)}" aria-label="${esc(t("account.actions.moveDownAria", { label: acc.label }))}"${ctrl.moveDownDisabled ? ` disabled aria-describedby="${esc(reasonIdByText.get(ctrl.moveDownReason!.text)!)}"` : ""}>${svgIcon("arrow-down")}</button>
            <button type="button" class="btn small ghost acc-btn-danger-outline" data-acc-action="remove" data-id="${esc(acc.id)}"${ctrl.removeDisabled ? ` disabled aria-describedby="${esc(reasonIdByText.get(ctrl.removeReason!.text)!)}"` : ""}>${svgIcon("trash")}<span>${esc(t("account.actions.remove"))}</span></button>
          </div>
          ${renamingId === acc.id ? renderRenameForm(acc, renameDraft, renameError, isSavingRename, t) : ""}
          ${reasonsHtml}
        </div>
      </li>`;
    })
    .join("");
}

export function renderTrashDialogContent(
  account: AccountItem,
  binName: string,
  pending: boolean,
  t: Translator,
): string {
  return `<h2 id="accTrashTitle">${esc(t("account.trash.title", { label: account.label }))}</h2>
    <p class="acc-trash-copy">${esc(t("account.trash.body", { label: account.label, binName }))}</p>
    <p class="acc-trash-note">${esc(t("account.trash.reassurance", { label: account.label }))}</p>
    <div class="acc-form-actions">
      <button type="button" class="btn small ghost" data-trash-cancel="true"${pending ? " disabled" : " autofocus"}>${esc(t("account.trash.cancel"))}</button>
      <button type="button" class="btn small acc-btn-danger" data-trash-confirm="true"${pending ? ' disabled aria-busy="true"' : ""}>${svgIcon("trash")}<span>${esc(pending ? t("account.actions.removing") : t("account.trash.confirm", { binName }))}</span></button>
    </div>`;
}

export function renderMonitorJobs(
  jobs: StudioJobView[],
  activeAccountId: string | null,
  activeAccountLabel: string | null,
  mediaFn: (path: string) => string,
  t: Translator,
  failoverPhase?: FailoverPhaseInfo | null,
): string {
  let stripHtml = "";
  if (failoverPhase) {
    const copy = getFailoverPhaseCopy(failoverPhase, t);
    stripHtml = `<div class="acc-failover-strip" role="status"><div class="acc-failover-strip-head">${svgIcon("refresh")}<strong>${esc(copy.heading)}</strong></div><p>${esc(copy.description)}</p></div>`;
  }
  if (!jobs.length) return `${stripHtml}<p class="empty">${esc(t("account.monitor.empty"))}</p>`;
  const jobsHtml = jobs
    .map((j) => {
      const proj = (j.project || "").split(/[\\/]/).pop();
      const progressText = j.progress ? ` ${esc(j.progress)}` : "";
      const creditsBadge =
        j.credits !== undefined ? `<span class="badge tabular">${esc(t("account.monitor.creditsBadge", { count: j.credits }))}</span>` : "";
      const attemptsBadge =
        j.attempts && j.attempts > 1 ? `<span class="badge tabular">${esc(t("account.monitor.attemptsBadge", { count: j.attempts }))}</span>` : "";
      let acctBadge = "";
      if (j.accountLabel) {
        if (j.failoverFrom) {
          acctBadge = `<span class="badge acc-job-badge" aria-label="${esc(t("account.monitor.jobAccountFailoverAria", { fromLabel: j.failoverFrom.accountLabel, accountLabel: j.accountLabel }))}">${esc(t("account.monitor.jobAccountFailover", { accountLabel: j.accountLabel, fromLabel: j.failoverFrom.accountLabel }))}</span>`;
        } else {
          acctBadge = `<span class="badge acc-job-badge" aria-label="${esc(t("account.monitor.jobAccountAria", { label: j.accountLabel }))}">${esc(t("account.monitor.jobAccount", { label: j.accountLabel }))}</span>`;
        }
      }
      const cancelBtn = j.status === "queued" ? `<button class="btn small ghost" data-cancel="${esc(j.id)}">${esc(t("account.actions.cancel"))}</button>` : "";

      const retryState = deriveJobRetryState(j, activeAccountId, activeAccountLabel);
      let retryBtn = "";
      let guardBox = "";
      let portableHint = "";
      if (retryState.isRetryable) {
        const retryText =
          j.status === "done"
            ? t(j.failed_scenes!.length > 1 ? "account.monitor.retryFailedMany" : "account.monitor.retryFailedOne", {
                count: j.failed_scenes!.length,
              })
            : t("account.actions.retry");
        const blockedAttrs = retryState.blocked ? ` disabled aria-describedby="retry-guard-${esc(j.id)}"` : "";
        retryBtn = `<button class="btn small" data-retry="${esc(j.id)}"${blockedAttrs}>${esc(retryText)}</button>`;
        if (retryState.portableCrossAccount) {
          portableHint = `<p class="acc-portable-retry-hint">${esc(t("account.monitor.retryPortableHint", { activeAccount: retryState.activeAccount }))}</p>`;
        }
        if (retryState.blocked) {
          guardBox = `<div id="retry-guard-${esc(j.id)}" class="acc-retry-guard">
            <strong>${svgIcon("alert-triangle")}<span>${esc(t("account.monitor.retryBlockedTitle", { jobAccount: retryState.jobAccount }))}</span></strong>
            <p>${esc(t("account.monitor.retryBlockedMessage", { jobAccount: retryState.jobAccount, activeAccount: retryState.activeAccount }))}</p>
            <p>${esc(t("account.monitor.retryBoundReason", { jobAccount: retryState.jobAccount }))}</p>
            <div class="acc-guard-foot">
              <span>${esc(t("account.monitor.retryBlockedHint", { jobAccount: retryState.jobAccount }))}</span>
              <button type="button" class="btn small ghost" data-open-accounts="true">${esc(t("account.dialog.title"))}</button>
            </div>
          </div>`;
        }
      }

      const trailSummary = formatFailoverTrail(j.failoverAttempts, t);
      const trailHtml = trailSummary ? `<p class="acc-failover-trail">${esc(trailSummary)}</p>` : "";
      const meter = j.status === "running" ? `<div class="meter"><i style="width:${parseInt(j.progress || "", 10) || 4}%"></i></div>` : "";
      const noteHtml = j.note ? `<p style="color:var(--warn)">${esc(j.note)}</p>` : "";
      const errHtml = j.error ? `<p class="err">${esc(j.error)}</p>` : "";
      const filesHtml = (j.files || [])
        .map((p) => {
          if (/\.(mp4|webm|mov)$/i.test(p)) return `<video controls playsinline preload="metadata" src="${mediaFn(p)}"></video>`;
          if (/\.(m4a|mp3|wav)$/i.test(p)) return `<audio controls src="${mediaFn(p)}"></audio>`;
          return `<img class="out" src="${mediaFn(p)}" alt="">`;
        })
        .join("");

      return `<div class="job"><div class="top"><span class="name">${esc(proj)} - ${esc(j.scene)}</span><span class="badge ${esc(j.status)}">${esc(j.status)}${progressText}</span>${acctBadge}${creditsBadge}${attemptsBadge}${cancelBtn}${retryBtn}</div>${trailHtml}${portableHint}${guardBox}${meter}<p>${esc(j.prompt)}</p>${noteHtml}${errHtml}${filesHtml}</div>`;
    })
    .join("");
  return `${stripHtml}${jobsHtml}`;
}

export function renderDraftMismatchBanner(
  surface: "frames" | "shots" | "cast",
  mismatch: DraftSurfaceMismatch | null,
  isAgentEngine: boolean,
  t: Translator,
): string {
  if (!mismatch) return "";
  const headingKey =
    surface === "cast"
      ? "account.drafts.castHeading"
      : surface === "frames"
        ? "account.drafts.framesHeading"
        : "account.drafts.shotsHeading";
  const descKey =
    surface === "cast"
      ? "account.drafts.castDescription"
      : surface === "shots"
        ? "account.drafts.shotsDescription"
        : isAgentEngine
          ? "account.drafts.framesAgentIgnored"
          : "account.drafts.framesDescription";
  const secondary = mismatch.switchTarget
    ? `<button type="button" class="btn small ghost" data-draft-switch="${esc(mismatch.switchTarget.id)}">${esc(t("account.drafts.switchToAccount", { label: mismatch.switchTarget.label }))}</button>`
    : `<button type="button" class="btn small ghost" data-open-accounts="true">${esc(t("account.drafts.openAccounts"))}</button>`;
  return `<div class="acc-draft-banner" role="status"><div class="acc-draft-banner-head">${svgIcon("alert-triangle")}<h3>${esc(t(headingKey))}</h3></div><p>${esc(t(descKey, { sourceLabels: mismatch.sourceLabels, activeLabel: mismatch.activeLabel }))}</p><div class="acc-banner-actions"><button type="button" class="btn small" data-draft-clear="${surface}">${esc(t("account.drafts.clearMismatched"))}</button>${secondary}</div></div>`;
}
