import {
  buildExhaustionPatch,
  buildFlowSyncPatch,
  classifyFailoverError,
  evaluateCandidateEligibility,
  PROJECT_URL_RE,
  type FailoverPhase,
} from "./account-failover-policy.js";
import type { AccountRecord, AccountStore, AccountView } from "./accounts.js";
import type { ChromeManager } from "./chrome.js";
import { AppError, ERROR_CODES } from "./errors.js";
import type { FlowState } from "./flow.js";
import { createAgentBatchResumeState, remainingSceneNumbers, type AgentBatchResumeState } from "./flow-agent-plan.js";
import { CreditExhaustedError } from "./flow-credits.js";
import { t } from "./i18n.js";
import type { FailoverAttempt, Job } from "./queue.js";

export type { FailoverPhase };

export interface FailoverFlowDriver {
  getFlowState: (detailed?: boolean) => Promise<FlowState>;
  createProject: (title?: string) => Promise<{ id: string; url: string; title: string }>;
}

export interface FailoverHooks {
  beginSwitch: () => void;
  endSwitch: () => void;
  markLoginCompleted: () => void;
}

export interface FailoverCoordinatorDeps {
  store: AccountStore;
  chrome: ChromeManager;
  flow: FailoverFlowDriver;
  hooks: FailoverHooks;
}

export async function captureActiveProjectUrl(
  store: AccountStore,
  chrome: ChromeManager,
  accountId: string,
  profileDir: string,
): Promise<void> {
  const probe = await chrome.probePassiveState(profileDir);
  if (probe.connected && probe.signedIn) {
    const m = probe.url.match(PROJECT_URL_RE);
    if (m) {
      store.updateMetadata(accountId, { lastProjectUrl: `${new URL(probe.url).origin}${m[0]}`, needsRelogin: false });
    }
  }
}

export class AccountFailoverCoordinator {
  private store: AccountStore;
  private chrome: ChromeManager;
  private flow: FailoverFlowDriver;
  private hooks: FailoverHooks;
  private phase: FailoverPhase | null = null;
  private abortRequested = false;

  constructor(deps: FailoverCoordinatorDeps) {
    this.store = deps.store;
    this.chrome = deps.chrome;
    this.flow = deps.flow;
    this.hooks = deps.hooks;
  }

  getPhase(): FailoverPhase | null { return this.phase; }
  requestAbort(): void { this.abortRequested = true; }

  revertPendingIfNeeded(): void {
    if (!this.store.getRegistryError() && this.store.getPendingFailover()) {
      this.store.revertPendingFailover();
    }
  }

  prepareQueuedJob(job: Job): void {
    const active = this.store.requireActiveAccount();
    if (job.accountId && job.accountId !== active.id) {
      if (!job.portable) {
        const ownerLabel = job.accountLabel ?? job.accountId;
        throw new AppError(409, ERROR_CODES.ACCOUNT_MISMATCH, t("error.ACCOUNT_MISMATCH", { expectedLabel: ownerLabel, activeLabel: active.label }), {
          jobId: job.id, ownerAccountId: job.accountId, ownerAccountLabel: ownerLabel, activeAccountId: active.id, activeLabel: active.label,
        });
      }
      job.accountId = active.id;
      job.accountLabel = active.label;
    }
  }

  async executeWithFailover(job: Job, runAttempt: (resume?: AgentBatchResumeState) => Promise<string[]>): Promise<string[]> {
    this.abortRequested = false;
    const resume = job.params.agent_scenes ? createAgentBatchResumeState() : undefined;
    const startAccount = this.store.requireActiveAccount();
    const attemptedIds = new Set<string>([startAccount.id]);
    const attemptsLog: FailoverAttempt[] = [];
    let currentAccount: AccountRecord = startAccount;
    let chromeSwitched = false;

    for (;;) {
      try {
        const files = await runAttempt(resume);
        if (currentAccount.id !== startAccount.id) {
          this.upsertAttempt(attemptsLog, { accountId: currentAccount.id, accountLabel: currentAccount.label, status: "succeeded", reason: "completed" });
          job.failoverAttempts = [...attemptsLog];
        }
        return files;
      } catch (err) {
        if (!(err instanceof CreditExhaustedError)) {
          this.syncPartialAgentState(job, resume);
          throw err;
        }

        const patch = buildExhaustionPatch(currentAccount, { requiredCost: err.requiredCost, creditsRemaining: err.creditsRemaining, nowMs: this.store.nowMs() });
        currentAccount = this.store.updateMetadata(currentAccount.id, patch);
        if (currentAccount.id !== startAccount.id) {
          this.upsertAttempt(attemptsLog, { accountId: currentAccount.id, accountLabel: currentAccount.label, status: "failed", code: ERROR_CODES.INSUFFICIENT_CREDITS, reason: err.reason });
        }

        if (!job.portable) {
          this.syncPartialAgentState(job, resume);
          throw new AppError(409, ERROR_CODES.ACCOUNT_BOUND_FAILOVER_BLOCKED, t("error.ACCOUNT_BOUND_FAILOVER_BLOCKED", { label: currentAccount.label }), { accountId: currentAccount.id, accountLabel: currentAccount.label, reason: err.reason });
        }
        if (!this.store.getAutoFailover()) {
          this.syncPartialAgentState(job, resume);
          throw new AppError(409, ERROR_CODES.AUTO_FAILOVER_DISABLED, t("error.AUTO_FAILOVER_DISABLED", { label: currentAccount.label }), { accountId: currentAccount.id, accountLabel: currentAccount.label, reason: err.reason });
        }

        const allAccounts = this.store.listAccounts();
        if (!allAccounts.some((a) => a.id !== startAccount.id)) {
          this.syncPartialAgentState(job, resume);
          throw new AppError(409, ERROR_CODES.INSUFFICIENT_CREDITS, t("error.INSUFFICIENT_CREDITS", { label: currentAccount.label }), { accountId: currentAccount.id, accountLabel: currentAccount.label, reason: err.reason });
        }

        job.params.agent_ref_assets = undefined;
        const requiredCost = err.requiredCost ?? 0;
        const next = await this.acquireNextCandidate({ startAccount, currentAccount, allAccounts, attemptedIds, attemptsLog, requiredCost, chromeSwitched });
        chromeSwitched = next.chromeSwitched;

        if (!next.readyAccount) {
          await this.revertToOriginal(startAccount, chromeSwitched, job, attemptsLog, resume);
          if (next.hostError) throw next.hostError;
          const summary = attemptsLog.map((a) => `${a.accountLabel}: ${a.reason}`).join("; ");
          throw new AppError(409, ERROR_CODES.FAILOVER_EXHAUSTED, t("error.FAILOVER_EXHAUSTED", { label: startAccount.label, summary }), {
            startAccountId: startAccount.id, startLabel: startAccount.label, attempts: attemptsLog,
          });
        }

        currentAccount = next.readyAccount;
        if (!job.failoverFrom) job.failoverFrom = { accountId: startAccount.id, accountLabel: startAccount.label };
        this.upsertAttempt(attemptsLog, { accountId: currentAccount.id, accountLabel: currentAccount.label, status: "succeeded", reason: "verified" });
        job.failoverAttempts = [...attemptsLog];
        job.accountId = currentAccount.id;
        job.accountLabel = currentAccount.label;
      }
    }
  }

  private syncPartialAgentState(job: Job, resume: AgentBatchResumeState | undefined): void {
    if (resume?.files.length) {
      job.files = [...resume.files];
      job.failed_scenes = remainingSceneNumbers(job.params, resume.done);
    }
  }

  private upsertAttempt(log: FailoverAttempt[], entry: FailoverAttempt): void {
    const idx = log.findIndex((item) => item.accountId === entry.accountId);
    if (idx >= 0) log[idx] = entry;
    else log.push(entry);
  }

  private async acquireNextCandidate(opts: {
    startAccount: AccountRecord;
    currentAccount: AccountRecord;
    allAccounts: AccountView[];
    attemptedIds: Set<string>;
    attemptsLog: FailoverAttempt[];
    requiredCost: number;
    chromeSwitched: boolean;
  }): Promise<{ readyAccount: AccountView | null; chromeSwitched: boolean; hostError?: Error }> {
    const { startAccount, currentAccount, allAccounts, attemptedIds, attemptsLog, requiredCost } = opts;
    let chromeSwitched = opts.chromeSwitched;
    const nowIso = () => new Date(this.store.nowMs()).toISOString();

    this.hooks.beginSwitch();
    this.phase = { stage: "evaluating", fromAccountId: startAccount.id, fromLabel: startAccount.label, startedAt: nowIso() };
    try {
      await captureActiveProjectUrl(this.store, this.chrome, currentAccount.id, this.store.getPaths(currentAccount).profileDir);

      for (const cand of allAccounts) {
        if (this.abortRequested) return { readyAccount: null, chromeSwitched };
        const elig = evaluateCandidateEligibility(cand, requiredCost, attemptedIds, startAccount.id, this.store.nowMs());
        if (!elig.eligible) {
          if (cand.id !== startAccount.id && !attemptsLog.some((a) => a.accountId === cand.id)) {
            attemptsLog.push({ accountId: cand.id, accountLabel: cand.label, status: "skipped", reason: t(`account.failover.skipReasons.${elig.reason}`) });
          }
          continue;
        }

        attemptedIds.add(cand.id);
        this.phase = { stage: "switching", fromAccountId: startAccount.id, fromLabel: startAccount.label, toAccountId: cand.id, toLabel: cand.label, startedAt: nowIso() };
        this.store.setPendingFailover({ originalAccountId: startAccount.id, candidateAccountId: cand.id, startedAt: nowIso() });
        chromeSwitched = true;

        try {
          const candPaths = this.store.getPaths(cand);
          const { authInProgress } = await this.chrome.switchProfile(candPaths.profileDir, cand.lastProjectUrl);
          this.store.setActive(cand.id, null);
          if (authInProgress) throw new AppError(503, ERROR_CODES.AUTH_REQUIRED, t("error.AUTH_REQUIRED"));

          this.phase = { ...this.phase, stage: "verifying" };
          let state = await this.flow.getFlowState(true);
          if (!state.signedIn) throw new AppError(503, ERROR_CODES.AUTH_REQUIRED, state.hint ?? t("error.AUTH_REQUIRED"));
          if (!state.inProject) {
            this.store.updateMetadata(cand.id, { lastProjectUrl: null, needsRelogin: false });
            const made = await this.flow.createProject();
            this.store.updateMetadata(cand.id, { lastProjectUrl: made.url, lastProjectTitle: made.title, needsRelogin: false });
            state = await this.flow.getFlowState(true);
          }

          this.hooks.markLoginCompleted();
          const updated = this.store.updateMetadata(cand.id, buildFlowSyncPatch(state, this.store.nowMs()));
          const effectiveCost = Math.max(1, requiredCost);
          if (state.credits_remaining !== undefined && state.credits_remaining < effectiveCost) {
            attemptsLog.push({ accountId: cand.id, accountLabel: cand.label, status: "failed", code: ERROR_CODES.INSUFFICIENT_CREDITS, reason: `${state.credits_remaining} < ${effectiveCost}` });
            continue;
          }

          this.store.setPendingFailover(null);
          return { readyAccount: updated, chromeSwitched };
        } catch (candErr) {
          const info = classifyFailoverError(candErr);
          if (info.markNeedsRelogin) this.store.updateMetadata(cand.id, { needsRelogin: true });
          attemptsLog.push({ accountId: cand.id, accountLabel: cand.label, status: "failed", code: info.code, reason: info.message });
          if (info.kind === "host") return { readyAccount: null, chromeSwitched, hostError: candErr as Error };
        }
      }
      return { readyAccount: null, chromeSwitched };
    } finally {
      this.phase = null;
      this.hooks.endSwitch();
    }
  }

  private async revertToOriginal(
    startAccount: AccountRecord,
    chromeSwitched: boolean,
    job: Job,
    attemptsLog: FailoverAttempt[],
    resume: AgentBatchResumeState | undefined,
  ): Promise<void> {
    this.hooks.beginSwitch();
    this.phase = { stage: "reverting", fromAccountId: startAccount.id, fromLabel: startAccount.label, startedAt: new Date(this.store.nowMs()).toISOString() };
    try {
      const freshStart = this.store.findAccount({ id: startAccount.id });
      if (chromeSwitched && !this.abortRequested) {
        await this.chrome.switchProfile(this.store.getPaths(freshStart).profileDir, freshStart.lastProjectUrl).catch(() => {});
      }
      this.store.setActive(freshStart.id, null);
      this.store.setPendingFailover(null);
      job.accountId = freshStart.id;
      job.accountLabel = freshStart.label;
      job.failoverFrom = undefined;
      job.failoverAttempts = [...attemptsLog];
      this.syncPartialAgentState(job, resume);
    } finally {
      this.phase = null;
      this.hooks.endSwitch();
    }
  }
}
