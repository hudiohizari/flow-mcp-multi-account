import { existsSync } from "node:fs";
import { z } from "zod";
import { resolveAccountPaths } from "./account-paths.js";
import { type FlowConfig } from "./config.js";
import { ACCOUNT_CONSTANTS, normalizeAccountLabel } from "./shared/account-validation.js";

export const AccountRecordSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  label: z.string().min(1),
  isDefault: z.boolean(),
  enabled: z.boolean(),
  priority: z.number().int().min(1),
  plan: z.string().optional(),
  creditsRemaining: z.number().int().min(0).optional(),
  balanceUpdatedAt: z.string().optional(),
  lastProjectUrl: z.string().optional(),
  lastProjectTitle: z.string().optional(),
  exhaustedMinCost: z.number().int().min(1).optional(),
  exhaustedAt: z.string().optional(),
  needsRelogin: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const PendingLoginSchema = z.object({
  targetAccountId: z.string().min(1),
  previousAccountId: z.string().min(1),
  startedAt: z.string(),
});

const PendingFailoverSchema = z.object({
  originalAccountId: z.string().min(1),
  candidateAccountId: z.string().min(1),
  startedAt: z.string(),
});

export const AccountRegistrySchema = z.object({
  version: z.literal(1),
  activeAccountId: z.string().min(1),
  pendingLogin: PendingLoginSchema.nullable(),
  pendingFailover: PendingFailoverSchema.nullable().default(null),
  autoFailover: z.boolean().default(true),
  retiredSlugs: z.array(z.string().min(1)).default([]),
  accounts: z.array(AccountRecordSchema).min(1),
});

export type AccountRecord = z.infer<typeof AccountRecordSchema>;
export type PendingLoginState = z.infer<typeof PendingLoginSchema>;
export type PendingFailoverState = z.infer<typeof PendingFailoverSchema>;
export type AccountRegistry = z.infer<typeof AccountRegistrySchema>;
export type AccountView = AccountRecord & { active: boolean; exhausted: boolean };
export interface AccountSelector { id?: string; label?: string }
export interface AccountMetadataPatch {
  plan?: string;
  creditsRemaining?: number;
  balanceUpdatedAt?: string;
  lastProjectUrl?: string | null;
  lastProjectTitle?: string | null;
  exhaustedMinCost?: number | null;
  exhaustedAt?: string | null;
  needsRelogin?: boolean;
}

export function createDefaultRegistry(now: string): AccountRegistry {
  return {
    version: 1,
    activeAccountId: ACCOUNT_CONSTANTS.DEFAULT_ID,
    pendingLogin: null,
    pendingFailover: null,
    autoFailover: true,
    retiredSlugs: [],
    accounts: [
      {
        id: ACCOUNT_CONSTANTS.DEFAULT_ID,
        slug: ACCOUNT_CONSTANTS.DEFAULT_SLUG,
        label: ACCOUNT_CONSTANTS.DEFAULT_LABEL,
        isDefault: true,
        enabled: true,
        priority: 1,
        needsRelogin: false,
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
}

export function hasUniqueInvariants(reg: AccountRegistry): boolean {
  const ids = new Set<string>();
  const slugs = new Set<string>();
  const labels = new Set<string>();
  let defaultCount = 0;
  for (const acc of reg.accounts) {
    if (ids.has(acc.id) || slugs.has(acc.slug)) return false;
    const lbl = normalizeAccountLabel(acc.label).toLowerCase();
    if (!lbl || labels.has(lbl)) return false;
    ids.add(acc.id);
    slugs.add(acc.slug);
    labels.add(lbl);
    if (acc.isDefault) defaultCount++;
  }
  return defaultCount === 1;
}

export function pickFallbackAccountId(reg: Pick<AccountRegistry, "accounts">): string {
  const enabled = [...reg.accounts].filter((a) => a.enabled).sort((a, b) => a.priority - b.priority);
  if (enabled.length > 0) return enabled[0].id;
  const def = reg.accounts.find((a) => a.isDefault) ?? reg.accounts[0];
  def.enabled = true;
  return def.id;
}

export function reconcileMissingProfiles(reg: AccountRegistry, config: FlowConfig, now: string): boolean {
  let changed = false;
  for (const acc of reg.accounts) {
    const paths = resolveAccountPaths(acc, config);
    const hasStaleMeta =
      acc.plan !== undefined ||
      acc.creditsRemaining !== undefined ||
      acc.balanceUpdatedAt !== undefined ||
      acc.lastProjectUrl !== undefined ||
      acc.lastProjectTitle !== undefined ||
      acc.exhaustedMinCost !== undefined ||
      acc.exhaustedAt !== undefined;
    if (!existsSync(paths.profileDir) && (hasStaleMeta || !acc.isDefault)) {
      acc.plan = undefined;
      acc.creditsRemaining = undefined;
      acc.balanceUpdatedAt = undefined;
      acc.lastProjectUrl = undefined;
      acc.lastProjectTitle = undefined;
      acc.exhaustedMinCost = undefined;
      acc.exhaustedAt = undefined;
      if (!acc.needsRelogin || hasStaleMeta) {
        acc.needsRelogin = true;
        acc.updatedAt = now;
        changed = true;
      }
    }
  }
  return changed;
}
