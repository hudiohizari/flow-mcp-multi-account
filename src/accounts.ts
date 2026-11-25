import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAccountExhaustedWithinTtl } from "./account-failover-policy.js";
import { ensurePrivateDir, resolveAccountPaths, trashAccountDir, writeFileAtomic, type AccountPaths } from "./account-paths.js";
import {
  AccountRegistrySchema,
  createDefaultRegistry,
  hasUniqueInvariants,
  pickFallbackAccountId,
  reconcileMissingProfiles,
  type AccountMetadataPatch,
  type AccountRecord,
  type AccountRegistry,
  type AccountSelector,
  type AccountView,
  type PendingFailoverState,
  type PendingLoginState,
} from "./account-registry.js";
import { type FlowConfig } from "./config.js";
import { AppError, ERROR_CODES } from "./errors.js";
import { t } from "./i18n.js";
import { moveToBin } from "./platform.js";
import { ACCOUNT_CONSTANTS, normalizeAccountLabel, slugifyAccountLabel, validateAccountLabel } from "./shared/account-validation.js";

export type {
  AccountMetadataPatch,
  AccountRecord,
  AccountRegistry,
  AccountSelector,
  AccountView,
  PendingFailoverState,
  PendingLoginState,
};

export class AccountStore {
  private registry: AccountRegistry | null = null;
  private registryError: string | null = null;
  private abandonedCandidateProfileDir: string | null = null;
  private config: FlowConfig;
  private trashFn: (target: string) => string;
  private now: () => number;

  constructor(config: FlowConfig, trashFn: (target: string) => string = moveToBin, now: () => number = Date.now) {
    this.config = config;
    this.trashFn = trashFn;
    this.now = now;
    this.loadOrInit();
  }

  nowMs(): number {
    return this.now();
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }

  private save(reg: AccountRegistry): void {
    ensurePrivateDir(this.config.homeDir);
    writeFileAtomic(this.config.accountsFile, JSON.stringify(reg, null, 2), 0o600, true);
  }

  private loadOrInit(): void {
    const now = this.isoNow();
    if (!existsSync(this.config.accountsFile)) {
      const reg = createDefaultRegistry(now);
      this.registry = reg;
      this.save(reg);
      return;
    }

    let parsed: AccountRegistry;
    try {
      const raw = JSON.parse(readFileSync(this.config.accountsFile, "utf8")) as unknown;
      parsed = AccountRegistrySchema.parse(raw);
      if (!hasUniqueInvariants(parsed)) throw new Error("Duplicate account invariants");
    } catch {
      this.registry = null;
      this.registryError = t("error.REGISTRY_CORRUPT");
      return;
    }

    let dirty = false;
    if (parsed.pendingLogin) {
      const prev = parsed.accounts.find((a) => a.id === parsed.pendingLogin!.previousAccountId && a.enabled);
      const target = parsed.accounts.find((a) => a.id === parsed.pendingLogin!.targetAccountId);
      if (target) target.needsRelogin = true;
      parsed.activeAccountId = prev ? prev.id : pickFallbackAccountId(parsed);
      parsed.pendingLogin = null;
      dirty = true;
    }
    if (parsed.pendingFailover) {
      const orig = parsed.accounts.find((a) => a.id === parsed.pendingFailover!.originalAccountId && a.enabled);
      const cand = parsed.accounts.find((a) => a.id === parsed.pendingFailover!.candidateAccountId);
      if (cand) this.abandonedCandidateProfileDir = resolveAccountPaths(cand, this.config).profileDir;
      parsed.activeAccountId = orig ? orig.id : pickFallbackAccountId(parsed);
      parsed.pendingFailover = null;
      dirty = true;
    }

    const active = parsed.accounts.find((a) => a.id === parsed.activeAccountId && a.enabled);
    if (!active) {
      parsed.activeAccountId = pickFallbackAccountId(parsed);
      dirty = true;
    }

    this.registry = parsed;
    const profileDirty = reconcileMissingProfiles(parsed, this.config, now);
    if (dirty || profileDirty) this.save(parsed);
  }

  getRegistryError(): string | null {
    return this.registryError;
  }

  assertHealthy(): AccountRegistry {
    if (!this.registry) {
      throw new AppError(500, ERROR_CODES.REGISTRY_CORRUPT, String(this.registryError));
    }
    return this.registry;
  }

  verifyProfilesOnDisk(): boolean {
    if (!this.registry) return false;
    const changed = reconcileMissingProfiles(this.registry, this.config, this.isoNow());
    if (changed) this.save(this.registry);
    return changed;
  }

  getAbandonedCandidateProfileDir(): string | null {
    return this.abandonedCandidateProfileDir;
  }

  clearAbandonedCandidateProfileDir(): void {
    this.abandonedCandidateProfileDir = null;
  }

  getAutoFailover(): boolean {
    return this.registry ? this.registry.autoFailover : true;
  }

  setAutoFailover(autoFailover: boolean): boolean {
    const reg = this.assertHealthy();
    reg.autoFailover = autoFailover;
    this.save(reg);
    return reg.autoFailover;
  }

  getPendingFailover(): PendingFailoverState | null {
    return this.registry ? this.registry.pendingFailover : null;
  }

  setPendingFailover(state: PendingFailoverState | null): void {
    const reg = this.assertHealthy();
    reg.pendingFailover = state;
    this.save(reg);
  }

  revertPendingFailover(): AccountView | null {
    const reg = this.assertHealthy();
    const pending = reg.pendingFailover;
    if (!pending) return null;
    const orig = reg.accounts.find((a) => a.id === pending.originalAccountId && a.enabled);
    reg.activeAccountId = orig ? orig.id : pickFallbackAccountId(reg);
    reg.pendingFailover = null;
    this.save(reg);
    return this.toView(this.requireActiveAccount(), reg.activeAccountId);
  }

  getPendingLogin(): PendingLoginState | null {
    return this.registry ? this.registry.pendingLogin : null;
  }

  getActiveAccount(): AccountRecord | null {
    if (!this.registry) return null;
    return this.registry.accounts.find((a) => a.id === this.registry!.activeAccountId)!;
  }

  requireActiveAccount(): AccountRecord {
    const reg = this.assertHealthy();
    return reg.accounts.find((a) => a.id === reg.activeAccountId)!;
  }

  getPaths(account: AccountRecord): AccountPaths {
    return resolveAccountPaths(account, this.config);
  }

  getActivePaths(): AccountPaths {
    const active = this.getActiveAccount();
    if (!active) return resolveAccountPaths({ slug: ACCOUNT_CONSTANTS.DEFAULT_SLUG, isDefault: true }, this.config);
    return resolveAccountPaths(active, this.config);
  }

  private toView(acc: AccountRecord, activeId: string): AccountView {
    return {
      ...acc,
      active: acc.id === activeId,
      exhausted: isAccountExhaustedWithinTtl(acc, this.now()),
    };
  }

  listAccounts(): AccountView[] {
    if (!this.registry) return [];
    const activeId = this.registry.activeAccountId;
    return [...this.registry.accounts].sort((a, b) => a.priority - b.priority).map((a) => this.toView(a, activeId));
  }

  findAccount(selector: AccountSelector): AccountRecord {
    const reg = this.assertHealthy();
    if (!selector.id && !selector.label) {
      throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, t("error.ACCOUNT_SELECTOR_REQUIRED"));
    }
    const found = selector.id
      ? reg.accounts.find((a) => a.id === selector.id)
      : reg.accounts.find((a) => normalizeAccountLabel(a.label).toLowerCase() === normalizeAccountLabel(selector.label!).toLowerCase());
    if (!found) {
      const target = selector.id ? selector.id : selector.label!;
      throw new AppError(404, ERROR_CODES.ACCOUNT_NOT_FOUND, t("error.ACCOUNT_NOT_FOUND", { target }));
    }
    return found;
  }

  addAccount(rawLabel: string): AccountView {
    const reg = this.assertHealthy();
    const check = validateAccountLabel(rawLabel, reg.accounts.map((a) => a.label));
    if (!check.ok) {
      throw new AppError(check.code === "DUPLICATE_LABEL" ? 409 : 400, ERROR_CODES[check.code], t(check.key, check.vars));
    }
    const diskSlugs = existsSync(this.config.accountsDir) ? readdirSync(this.config.accountsDir) : [];
    const slug = slugifyAccountLabel(check.label, [...reg.accounts.map((a) => a.slug), ...reg.retiredSlugs, ...diskSlugs]);
    const now = this.isoNow();
    const maxPriority = Math.max(0, ...reg.accounts.map((a) => a.priority));
    const record: AccountRecord = {
      id: randomUUID(),
      slug,
      label: check.label,
      isDefault: false,
      enabled: true,
      priority: maxPriority + 1,
      needsRelogin: true,
      createdAt: now,
      updatedAt: now,
    };
    const paths = resolveAccountPaths(record, this.config);
    ensurePrivateDir(this.config.accountsDir);
    ensurePrivateDir(paths.accountRoot);
    ensurePrivateDir(paths.profileDir);
    reg.accounts.push(record);
    this.save(reg);
    return this.toView(record, reg.activeAccountId);
  }

  renameAccount(selector: AccountSelector, rawLabel: string): AccountView {
    const reg = this.assertHealthy();
    const acc = this.findAccount(selector);
    const others = reg.accounts.filter((a) => a.id !== acc.id).map((a) => a.label);
    const check = validateAccountLabel(rawLabel, others);
    if (!check.ok) {
      throw new AppError(check.code === "DUPLICATE_LABEL" ? 409 : 400, ERROR_CODES[check.code], t(check.key, check.vars));
    }
    acc.label = check.label;
    acc.updatedAt = this.isoNow();
    this.save(reg);
    return this.toView(acc, reg.activeAccountId);
  }

  enableAccount(selector: AccountSelector, enabled: boolean): AccountView {
    const reg = this.assertHealthy();
    const acc = this.findAccount(selector);
    if (!enabled) {
      const enabledCount = reg.accounts.filter((a) => a.enabled).length;
      if (acc.enabled && enabledCount <= 1) {
        throw new AppError(409, ERROR_CODES.CANNOT_DISABLE_LAST, t("error.CANNOT_DISABLE_LAST", { label: acc.label }));
      }
      if (acc.id === reg.activeAccountId) {
        throw new AppError(409, ERROR_CODES.CANNOT_DISABLE_ACTIVE, t("error.CANNOT_DISABLE_ACTIVE", { label: acc.label }));
      }
    }
    acc.enabled = enabled;
    acc.updatedAt = this.isoNow();
    this.save(reg);
    return this.toView(acc, reg.activeAccountId);
  }

  reorderAccounts(ids: string[]): AccountView[] {
    const reg = this.assertHealthy();
    const existing = new Set(reg.accounts.map((a) => a.id));
    if (ids.length !== reg.accounts.length || new Set(ids).size !== ids.length || ids.some((id) => !existing.has(id))) {
      throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, t("error.INVALID_REORDER"));
    }
    const now = this.isoNow();
    ids.forEach((id, index) => {
      const acc = reg.accounts.find((a) => a.id === id)!;
      acc.priority = index + 1;
      acc.updatedAt = now;
    });
    this.save(reg);
    return this.listAccounts();
  }

  removeAccount(selector: AccountSelector): { removedId: string; trashedTo: string | null; accounts: AccountView[] } {
    const reg = this.assertHealthy();
    const acc = this.findAccount(selector);
    if (acc.id === reg.activeAccountId) {
      throw new AppError(409, ERROR_CODES.CANNOT_REMOVE_ACTIVE, t("error.CANNOT_REMOVE_ACTIVE", { label: acc.label }));
    }
    if (acc.isDefault) {
      throw new AppError(409, ERROR_CODES.CANNOT_REMOVE_DEFAULT, t("error.CANNOT_REMOVE_DEFAULT", { label: acc.label }));
    }
    const trashedTo = trashAccountDir(this.config.accountsDir, acc.slug, this.trashFn);
    reg.accounts = reg.accounts.filter((a) => a.id !== acc.id).sort((a, b) => a.priority - b.priority);
    reg.accounts.forEach((a, idx) => {
      a.priority = idx + 1;
    });
    reg.retiredSlugs = [...new Set([...reg.retiredSlugs, acc.slug])];
    this.save(reg);
    return { removedId: acc.id, trashedTo, accounts: this.listAccounts() };
  }

  setActive(id: string, pendingLogin: PendingLoginState | null = null): AccountView {
    const reg = this.assertHealthy();
    const acc = this.findAccount({ id });
    reg.activeAccountId = acc.id;
    reg.pendingLogin = pendingLogin;
    acc.updatedAt = this.isoNow();
    this.save(reg);
    return this.toView(acc, reg.activeAccountId);
  }

  clearPendingLogin(): void {
    const reg = this.assertHealthy();
    if (!reg.pendingLogin) return;
    reg.pendingLogin = null;
    this.save(reg);
  }

  revertPendingLogin(): AccountView | null {
    const reg = this.assertHealthy();
    const pending = reg.pendingLogin;
    if (!pending) return null;
    const target = reg.accounts.find((a) => a.id === pending.targetAccountId);
    if (target) target.needsRelogin = true;
    const prev = reg.accounts.find((a) => a.id === pending.previousAccountId && a.enabled);
    reg.activeAccountId = prev ? prev.id : pickFallbackAccountId(reg);
    reg.pendingLogin = null;
    this.save(reg);
    return this.toView(this.requireActiveAccount(), reg.activeAccountId);
  }

  updateMetadata(id: string, patch: AccountMetadataPatch): AccountView {
    const reg = this.assertHealthy();
    const acc = this.findAccount({ id });
    if (patch.plan !== undefined) acc.plan = patch.plan;
    if (patch.creditsRemaining !== undefined) acc.creditsRemaining = patch.creditsRemaining;
    if (patch.balanceUpdatedAt !== undefined) acc.balanceUpdatedAt = patch.balanceUpdatedAt;
    if (patch.lastProjectUrl === null) {
      acc.lastProjectUrl = undefined;
      acc.lastProjectTitle = undefined;
    } else if (patch.lastProjectUrl !== undefined) {
      acc.lastProjectUrl = patch.lastProjectUrl;
    }
    if (patch.lastProjectTitle === null) acc.lastProjectTitle = undefined;
    else if (patch.lastProjectTitle !== undefined) acc.lastProjectTitle = patch.lastProjectTitle;
    if (patch.exhaustedMinCost === null) acc.exhaustedMinCost = undefined;
    else if (patch.exhaustedMinCost !== undefined) acc.exhaustedMinCost = patch.exhaustedMinCost;
    if (patch.exhaustedAt === null) acc.exhaustedAt = undefined;
    else if (patch.exhaustedAt !== undefined) acc.exhaustedAt = patch.exhaustedAt;
    if (patch.needsRelogin !== undefined) acc.needsRelogin = patch.needsRelogin;
    acc.updatedAt = this.isoNow();
    this.save(reg);
    return this.toView(acc, reg.activeAccountId);
  }
}
