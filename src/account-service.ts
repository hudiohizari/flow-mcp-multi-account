import type { FailoverHooks } from "./account-failover.js";
import { captureActiveProjectUrl } from "./account-failover.js";
import { buildFlowSyncPatch, type FailoverPhase } from "./account-failover-policy.js";
import { resolveAccountPaths, type AccountPaths } from "./account-paths.js";
import type { AccountSelector, AccountStore, AccountView, PendingLoginState } from "./accounts.js";
import { isFlowHost, isSignInUrl, type ChromeManager } from "./chrome.js";
import type { FlowConfig } from "./config.js";
import { buildJobView } from "./core-accounts.js";
import { AppError, ERROR_CODES } from "./errors.js";
import type { FlowState } from "./flow.js";
import { t } from "./i18n.js";
import type { JobQueue } from "./queue.js";

export interface FlowDriver {
  getFlowState: (detailed?: boolean) => Promise<FlowState>;
  createProject: (title?: string) => Promise<{ id: string; url: string; title: string }>;
  listCharacters: () => Promise<string[]>;
}

export interface AccountServiceDeps {
  store: AccountStore;
  chrome: ChromeManager;
  queue: JobQueue;
  getConfig: () => FlowConfig;
  flow: FlowDriver;
}

export class AccountService {
  private store: AccountStore;
  private chrome: ChromeManager;
  private queue: JobQueue;
  private getConfig: () => FlowConfig;
  private flow: FlowDriver;
  private inFlightChromeOps = 0;
  private switchPending = false;
  private loginCompleted = false;
  private stateEpoch = 0;
  private failoverPhaseProvider: () => FailoverPhase | null = () => null;

  constructor(deps: AccountServiceDeps) {
    this.store = deps.store;
    this.chrome = deps.chrome;
    this.queue = deps.queue;
    this.getConfig = deps.getConfig;
    this.flow = deps.flow;
  }

  setFailoverPhaseProvider(provider: () => FailoverPhase | null): void {
    this.failoverPhaseProvider = provider;
  }

  getInternalSwitchHooks(): FailoverHooks {
    return {
      beginSwitch: () => {
        this.switchPending = true;
        this.stateEpoch++;
      },
      endSwitch: () => {
        this.switchPending = false;
      },
      markLoginCompleted: () => this.markLoginCompleted(),
    };
  }

  getActivePaths(): AccountPaths { return this.store.getActivePaths(); }
  getActiveCastDir(): string { return this.store.getActivePaths().castDir; }
  requireActiveAccount() { return this.store.requireActiveAccount(); }

  private isSwitchActive(): boolean { return this.switchPending || this.chrome.switchInProgress; }

  private isStatusStale(startActiveId: string, startEpoch: number): boolean {
    return this.isSwitchActive() || this.stateEpoch !== startEpoch || this.store.requireActiveAccount().id !== startActiveId;
  }

  private markLoginCompleted(): void { this.loginCompleted = true; this.store.clearPendingLogin(); }
  private revertPending(): void { this.stateEpoch++; this.store.revertPendingLogin(); }

  isChromeBusy(): boolean {
    return this.queue.active || this.inFlightChromeOps > 0 || this.isSwitchActive();
  }

  assertIdleForSwitch(): void {
    if (this.isSwitchActive()) {
      throw new AppError(409, ERROR_CODES.SWITCH_IN_PROGRESS, t("error.SWITCH_IN_PROGRESS"));
    }
    if (this.queue.active || this.inFlightChromeOps > 0) {
      throw new AppError(409, ERROR_CODES.CHROME_BUSY, t("error.CHROME_BUSY"));
    }
  }

  async wrapChromeOp<T>(fn: () => Promise<T>): Promise<T> {
    this.assertIdleForSwitch();
    this.store.assertHealthy();
    this.inFlightChromeOps++;
    try {
      return await fn();
    } finally {
      this.inFlightChromeOps--;
    }
  }

  listAccounts() {
    this.store.verifyProfilesOnDisk();
    const active = this.store.getActiveAccount();
    return {
      activeAccountId: active ? active.id : null,
      pendingLogin: this.store.getPendingLogin(),
      pendingFailover: this.store.getPendingFailover(),
      autoFailover: this.store.getAutoFailover(),
      registryError: this.store.getRegistryError(),
      accounts: this.store.listAccounts(),
    };
  }

  addAccount(label: string): { account: AccountView; accounts: AccountView[] } {
    const account = this.store.addAccount(label);
    return { account, accounts: this.store.listAccounts() };
  }

  renameAccount(selector: AccountSelector & { current_label?: string }, label: string) {
    const targetSelector: AccountSelector = { id: selector.id, label: selector.current_label ?? selector.label };
    const account = this.store.renameAccount(targetSelector, label);
    return { account, accounts: this.store.listAccounts() };
  }

  enableAccount(selector: AccountSelector, enabled: boolean) {
    this.store.assertHealthy();
    this.assertIdleForSwitch();
    const account = this.store.enableAccount(selector, enabled);
    return { account, accounts: this.store.listAccounts() };
  }

  reorderAccounts(ids: string[]) {
    this.store.assertHealthy();
    this.assertIdleForSwitch();
    return { accounts: this.store.reorderAccounts(ids) };
  }

  removeAccount(selector: AccountSelector) {
    this.store.assertHealthy();
    this.assertIdleForSwitch();
    return this.store.removeAccount(selector);
  }

  configureFailover(autoFailover?: boolean): { autoFailover: boolean } {
    this.store.assertHealthy();
    if (autoFailover === undefined) return { autoFailover: this.store.getAutoFailover() };
    this.assertIdleForSwitch();
    return { autoFailover: this.store.setAutoFailover(autoFailover) };
  }

  private syncFlowMetadata(accountId: string, state: FlowState): AccountView {
    if (state.signedIn) this.markLoginCompleted();
    return this.store.updateMetadata(accountId, buildFlowSyncPatch(state, this.store.nowMs()));
  }

  async switchAccount(selector: AccountSelector) {
    this.store.assertHealthy();
    const target = this.store.findAccount(selector);
    if (!target.enabled) {
      throw new AppError(409, ERROR_CODES.ACCOUNT_DISABLED, t("error.ACCOUNT_DISABLED", { label: target.label }));
    }
    this.assertIdleForSwitch();
    const active = this.store.requireActiveAccount();
    const cfg = this.getConfig();
    const targetPaths = resolveAccountPaths(target, cfg);
    if (target.id === active.id) {
      const flow = await this.chrome.probePassiveState(targetPaths.profileDir);
      return { switched: false, alreadyActive: true, account: this.store.listAccounts().find((a) => a.id === active.id)!, flow };
    }

    this.switchPending = true;
    this.stateEpoch++;
    try {
      const activePaths = resolveAccountPaths(active, cfg);
      await captureActiveProjectUrl(this.store, this.chrome, active.id, activePaths.profileDir);
      const { page, authInProgress } = await this.chrome.switchProfile(targetPaths.profileDir, target.lastProjectUrl);
      this.loginCompleted = !authInProgress;
      this.store.setActive(target.id, null);

      const flow: FlowState = authInProgress
        ? { url: page.url(), connected: true, signedIn: false, inProject: false, authInProgress: true, hint: t("hint.authInProgress") }
        : await this.flow.getFlowState(true).catch(() => ({
            url: page.url(), connected: true, signedIn: false, inProject: false, authInProgress: false, hint: t("hint.signIn"),
          }));
      const updated = this.syncFlowMetadata(target.id, flow);
      return { switched: true, account: updated, flow: { ...flow, balanceUpdatedAt: updated.balanceUpdatedAt } };
    } finally {
      this.switchPending = false;
    }
  }

  async loginAccount(selector: AccountSelector) {
    this.store.assertHealthy();
    const target = selector.id || selector.label ? this.store.findAccount(selector) : this.store.requireActiveAccount();
    if (!target.enabled) {
      throw new AppError(409, ERROR_CODES.ACCOUNT_DISABLED, t("error.ACCOUNT_DISABLED", { label: target.label }));
    }
    const active = this.store.requireActiveAccount();
    const switchFromOther = target.id !== active.id;
    if (switchFromOther) {
      this.assertIdleForSwitch();
    } else if (this.isSwitchActive()) {
      throw new AppError(409, ERROR_CODES.SWITCH_IN_PROGRESS, t("error.SWITCH_IN_PROGRESS"));
    }

    const cfg = this.getConfig();
    const prevId = active.id;
    const targetPaths = resolveAccountPaths(target, cfg);
    const pending: PendingLoginState | null = switchFromOther
      ? { targetAccountId: target.id, previousAccountId: prevId, startedAt: new Date(this.store.nowMs()).toISOString() }
      : this.store.getPendingLogin();

    this.switchPending = true;
    this.stateEpoch++;
    try {
      if (switchFromOther) {
        const activePaths = resolveAccountPaths(active, cfg);
        await captureActiveProjectUrl(this.store, this.chrome, active.id, activePaths.profileDir);
        this.loginCompleted = false;
        this.store.setActive(target.id, pending);
      }

      let launched: Awaited<ReturnType<ChromeManager["launchForLogin"]>>;
      try {
        launched = await this.chrome.launchForLogin(targetPaths.profileDir, target.lastProjectUrl, {
          switchFromOther,
          onDisconnect: () => {
            const curPending = this.store.getPendingLogin();
            if (!this.loginCompleted && curPending && curPending.targetAccountId === target.id) {
              this.revertPending();
            }
          },
        });
      } catch (err) {
        if (switchFromOther) this.revertPending();
        throw err;
      }
      if (!launched.authInProgress && isFlowHost(launched.url, cfg) && !isSignInUrl(launched.url, cfg)) {
        this.markLoginCompleted();
        this.store.updateMetadata(target.id, { needsRelogin: false });
      }
      return {
        account: this.store.listAccounts().find((a) => a.id === target.id)!,
        url: launched.url,
        profileDir: targetPaths.profileDir,
        authInProgress: launched.authInProgress,
        pendingLogin: this.store.getPendingLogin(),
      };
    } finally {
      this.switchPending = false;
    }
  }

  async refreshAccount(selector: AccountSelector) {
    this.store.assertHealthy();
    const active = this.store.requireActiveAccount();
    const target = selector.id || selector.label ? this.store.findAccount(selector) : active;
    if (target.id !== active.id) {
      throw new AppError(409, ERROR_CODES.ACCOUNT_MISMATCH, t("error.ACCOUNT_MISMATCH", { expectedLabel: target.label, activeLabel: active.label }), {
        expectedAccountId: target.id, expectedLabel: target.label, activeAccountId: active.id, activeLabel: active.label,
      });
    }
    if (this.isChromeBusy()) {
      return { refreshed: false, busy: true, account: this.store.listAccounts().find((a) => a.id === active.id)! };
    }

    this.inFlightChromeOps++;
    try {
      const flow = await this.flow.getFlowState(true);
      if (!flow.signedIn) {
        this.store.updateMetadata(active.id, { needsRelogin: true });
        throw new AppError(503, ERROR_CODES.AUTH_REQUIRED, flow.hint ?? t("error.AUTH_REQUIRED"));
      }
      if (!flow.inProject) {
        this.store.updateMetadata(active.id, { lastProjectUrl: null, needsRelogin: false });
        throw new AppError(409, ERROR_CODES.NOT_IN_PROJECT, flow.hint ?? t("error.NOT_IN_PROJECT"));
      }
      const account = this.syncFlowMetadata(active.id, flow);
      return { refreshed: true, account, flow: { ...flow, balanceUpdatedAt: account.balanceUpdatedAt } };
    } finally {
      this.inFlightChromeOps--;
    }
  }

  async syncPostJobReadout(accountId: string): Promise<void> {
    if (this.store.getRegistryError() || this.isSwitchActive()) return;
    const startEpoch = this.stateEpoch;
    const state = await this.flow.getFlowState(true).catch(() => null);
    if (state && !this.isStatusStale(accountId, startEpoch)) this.syncFlowMetadata(accountId, state);
  }

  async createProjectForActive(title?: string) {
    return this.wrapChromeOp(async () => {
      const active = this.store.requireActiveAccount();
      const made = await this.flow.createProject(title);
      this.markLoginCompleted();
      this.store.updateMetadata(active.id, { lastProjectUrl: made.url, lastProjectTitle: made.title, needsRelogin: false });
      return made;
    });
  }

  private offlineFlow(active: { plan?: string; creditsRemaining?: number; balanceUpdatedAt?: string } | null, authInProgress: boolean, hint?: string): FlowState {
    return {
      url: "", connected: false, signedIn: false, inProject: false, authInProgress,
      plan: active?.plan, credits_remaining: active?.creditsRemaining, balanceUpdatedAt: active?.balanceUpdatedAt, hint,
    };
  }

  private staleStatusFlow(): FlowState {
    const fresh = this.store.requireActiveAccount();
    const authInProgress = this.store.getPendingLogin() !== null;
    const hint = this.isSwitchActive() ? t("hint.switchInProgress") : authInProgress ? t("hint.authInProgress") : undefined;
    return this.offlineFlow(fresh, authInProgress, hint);
  }

  private statusPayload(flow: FlowState, activeView: AccountView | null, accounts: AccountView[], registryError: string | null) {
    return {
      flow,
      activeAccount: activeView,
      activeAccountId: activeView ? activeView.id : null,
      accounts,
      pendingLogin: registryError ? null : this.store.getPendingLogin(),
      pendingFailover: registryError ? null : this.store.getPendingFailover(),
      autoFailover: registryError ? true : this.store.getAutoFailover(),
      failoverPhase: registryError ? null : this.failoverPhaseProvider(),
      registryError,
      busy: this.isChromeBusy(),
      switchInProgress: this.isSwitchActive(),
      pacing: this.queue.pausedReason,
      output_root: this.getConfig().outputRoot,
      jobs: this.queue.list().map(buildJobView),
    };
  }

  async getStatus(detailed: boolean) {
    const cfg = this.getConfig();
    const regErr = this.store.getRegistryError();
    if (regErr) return this.statusPayload(this.offlineFlow(null, false, regErr), null, [], regErr);

    this.store.verifyProfilesOnDisk();
    let active = this.store.requireActiveAccount();
    const startActiveId = active.id;
    const startEpoch = this.stateEpoch;
    const paths = resolveAccountPaths(active, cfg);
    const shouldScrape = detailed && !this.isChromeBusy();
    let flow: FlowState;

    if (this.isSwitchActive()) {
      flow = this.staleStatusFlow();
    } else if (!shouldScrape) {
      const passive = await this.chrome.probePassiveState(paths.profileDir);
      if (this.isStatusStale(startActiveId, startEpoch)) {
        flow = this.staleStatusFlow();
      } else {
        if (passive.signedIn) {
          this.markLoginCompleted();
          if (active.needsRelogin) active = this.store.updateMetadata(active.id, { needsRelogin: false });
        }
        flow = {
          ...passive,
          plan: active.plan,
          credits_remaining: active.creditsRemaining,
          balanceUpdatedAt: active.balanceUpdatedAt,
          hint: passive.hint ?? (active.needsRelogin ? t("hint.needsRelogin", { label: active.label }) : undefined),
        };
      }
    } else {
      this.inFlightChromeOps++;
      try {
        flow = await this.flow.getFlowState(true);
        if (this.isStatusStale(startActiveId, startEpoch)) {
          flow = this.staleStatusFlow();
        } else {
          active = this.syncFlowMetadata(active.id, flow);
          flow = { ...flow, plan: flow.plan ?? active.plan, credits_remaining: flow.credits_remaining ?? active.creditsRemaining, balanceUpdatedAt: active.balanceUpdatedAt };
        }
      } catch (err) {
        flow = this.isStatusStale(startActiveId, startEpoch)
          ? this.staleStatusFlow()
          : this.offlineFlow(active, false, err instanceof Error ? err.message : String(err));
      } finally {
        this.inFlightChromeOps--;
      }
    }

    const accounts = this.store.listAccounts();
    return this.statusPayload(flow, accounts.find((a) => a.active)!, accounts, null);
  }
}
