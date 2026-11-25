import { AppError, ERROR_CODES, type ErrorCode } from "./errors.js";
import type { AccountMetadataPatch, AccountRecord } from "./account-registry.js";
import type { SceneParams } from "./queue.js";

export const EXHAUSTION_TTL_MS = 86_400_000;
export const PROJECT_URL_RE = /\/project\/[0-9a-f-]{36}/;

type FailoverStage = "evaluating" | "switching" | "verifying" | "reverting";

export interface FailoverPhase {
  stage: FailoverStage;
  fromAccountId: string;
  fromLabel: string;
  toAccountId?: string;
  toLabel?: string;
  startedAt: string;
}

export interface FlowSyncInput {
  url: string;
  connected?: boolean;
  signedIn: boolean;
  plan?: string;
  credits_remaining?: number;
}

export function buildFlowSyncPatch(state: FlowSyncInput, nowMs: number): AccountMetadataPatch {
  const patch: AccountMetadataPatch = {};
  if (state.signedIn) {
    patch.needsRelogin = false;
    const m = state.url.match(PROJECT_URL_RE);
    if (m) patch.lastProjectUrl = `${new URL(state.url).origin}${m[0]}`;
    else if (state.connected !== false) patch.lastProjectUrl = null;
  }
  if (state.plan !== undefined) patch.plan = state.plan;
  if (state.credits_remaining !== undefined) {
    patch.creditsRemaining = state.credits_remaining;
    patch.exhaustedMinCost = null;
    patch.exhaustedAt = null;
  }
  if (state.plan !== undefined || state.credits_remaining !== undefined) {
    patch.balanceUpdatedAt = new Date(nowMs).toISOString();
  }
  return patch;
}

export type FailoverCandidateSkipReason =
  | "already_attempted"
  | "disabled"
  | "needs_relogin"
  | "insufficient_cached_credits"
  | "recently_exhausted";

export type FailoverErrorKind = "host" | "account";

const HOST_WIDE_CODES: ReadonlySet<ErrorCode> = new Set([
  ERROR_CODES.CHROME_NOT_FOUND,
  ERROR_CODES.CDP_PORT_OCCUPIED,
  ERROR_CODES.CDP_WRONG_PROFILE,
  ERROR_CODES.REGISTRY_CORRUPT,
  ERROR_CODES.CDP_UNAVAILABLE,
  ERROR_CODES.INTERNAL_ERROR,
]);

export function isJobPortable(params: SceneParams): boolean {
  if (params.edit_asset || params.continue_from) return false;
  if (params.agent_ref_assets?.length) return false;
  if (params.first_frame?.startsWith("asset:")) return false;
  if (params.last_frame?.startsWith("asset:")) return false;
  if (params.reference_images?.some((r) => r.startsWith("asset:"))) return false;
  if (params.agent_refs?.some((r) => r.image.startsWith("asset:"))) return false;
  return true;
}

export function isTimestampFresh(iso: string | undefined, nowMs: number, ttlMs = EXHAUSTION_TTL_MS): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return false;
  return nowMs - ms < ttlMs;
}

export function isAccountExhaustedWithinTtl(
  acc: Pick<AccountRecord, "creditsRemaining" | "balanceUpdatedAt" | "exhaustedMinCost" | "exhaustedAt">,
  nowMs: number,
  ttlMs = EXHAUSTION_TTL_MS,
): boolean {
  if (acc.creditsRemaining === 0 && isTimestampFresh(acc.balanceUpdatedAt, nowMs, ttlMs)) return true;
  if (acc.exhaustedMinCost !== undefined && isTimestampFresh(acc.exhaustedAt, nowMs, ttlMs)) return true;
  return false;
}

export function evaluateCandidateEligibility(
  acc: AccountRecord,
  requiredCost: number,
  attemptedIds: ReadonlySet<string>,
  startAccountId: string,
  nowMs: number,
  ttlMs = EXHAUSTION_TTL_MS,
): { eligible: true } | { eligible: false; reason: FailoverCandidateSkipReason } {
  if (acc.id === startAccountId || attemptedIds.has(acc.id)) {
    return { eligible: false, reason: "already_attempted" };
  }
  if (!acc.enabled) return { eligible: false, reason: "disabled" };
  if (acc.needsRelogin) return { eligible: false, reason: "needs_relogin" };

  const effectiveCost = Math.max(1, requiredCost);
  if (acc.creditsRemaining !== undefined && isTimestampFresh(acc.balanceUpdatedAt, nowMs, ttlMs)) {
    if (acc.creditsRemaining === 0 || acc.creditsRemaining < effectiveCost) {
      return { eligible: false, reason: "insufficient_cached_credits" };
    }
  }
  if (acc.exhaustedMinCost !== undefined && isTimestampFresh(acc.exhaustedAt, nowMs, ttlMs)) {
    if (effectiveCost >= acc.exhaustedMinCost) {
      return { eligible: false, reason: "recently_exhausted" };
    }
  }
  return { eligible: true };
}

export function buildExhaustionPatch(
  acc: Pick<AccountRecord, "exhaustedMinCost" | "exhaustedAt">,
  opts: { requiredCost?: number; creditsRemaining?: number; nowMs: number; ttlMs?: number },
) {
  const nowIso = new Date(opts.nowMs).toISOString();
  const cost = Math.max(1, opts.requiredCost ?? 1);
  if (opts.creditsRemaining !== undefined) {
    const stillInsufficientAtRead = opts.creditsRemaining >= cost;
    return {
      creditsRemaining: opts.creditsRemaining,
      balanceUpdatedAt: nowIso,
      ...(stillInsufficientAtRead
        ? { exhaustedMinCost: cost, exhaustedAt: nowIso }
        : { exhaustedMinCost: null, exhaustedAt: null }),
    };
  }
  const prevFresh = acc.exhaustedMinCost !== undefined && isTimestampFresh(acc.exhaustedAt, opts.nowMs, opts.ttlMs);
  const minCost = prevFresh ? Math.min(acc.exhaustedMinCost!, cost) : cost;
  return {
    exhaustedMinCost: minCost,
    exhaustedAt: nowIso,
  };
}

export function classifyFailoverError(err: unknown): {
  kind: FailoverErrorKind;
  code: ErrorCode;
  message: string;
  markNeedsRelogin: boolean;
} {
  if (err instanceof AppError) {
    const kind: FailoverErrorKind = HOST_WIDE_CODES.has(err.code) ? "host" : "account";
    const markNeedsRelogin = err.code === ERROR_CODES.AUTH_REQUIRED || err.code === ERROR_CODES.PROFILE_MISSING;
    return { kind, code: err.code, message: err.message, markNeedsRelogin };
  }
  if (err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError) {
    return { kind: "host", code: ERROR_CODES.INTERNAL_ERROR, message: err.message, markNeedsRelogin: false };
  }
  return {
    kind: "account",
    code: ERROR_CODES.INVALID_STATE,
    message: err instanceof Error ? err.message : String(err),
    markNeedsRelogin: false,
  };
}
