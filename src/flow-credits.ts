import { AppError, ERROR_CODES } from "./errors.js";
import { t } from "./i18n.js";

export class CreditExhaustedError extends Error {
  readonly requiredCost?: number;
  readonly creditsRemaining?: number;
  readonly reason: string;

  constructor(opts: { reason: string; requiredCost?: number; creditsRemaining?: number }) {
    super(opts.reason);
    this.name = "CreditExhaustedError";
    this.reason = opts.reason;
    this.requiredCost = opts.requiredCost;
    this.creditsRemaining = opts.creditsRemaining;
  }
}

const POLICY_ERROR_RE = /polic|violat|prominent|safety|not allowed|guideline/i;
const CREDIT_EXHAUSTED_RE =
  /add ai credits|insufficient\s+credits?|out\s+of\s+(?:ai\s+)?credits?|not\s+enough\s+credits?|no\s+credits?\s+(?:left|remaining)|credit\s+limit|quota\s+(?:exceeded|exhausted)|credits?\s+(?:exhausted|depleted|ran\s+out)/i;

export function parseQuotedCredits(costText: string): number {
  const match = costText.match(/(\d[\d,]*)\s+credits?/i)?.[1] ?? costText.match(/\d[\d,]*/)?.[0];
  if (!match) return NaN;
  const cleaned = match.replaceAll(",", "");
  return Number(cleaned);
}

export function parseBalanceCredits(balanceText: string): number | undefined {
  const match = balanceText.match(/\d[\d,]*/)?.[0];
  if (!match) return undefined;
  const n = Number(match.replaceAll(",", ""));
  return Number.isFinite(n) ? n : undefined;
}

export function assertWithinMaxCredits(cost: number, maxCredits: number | undefined): void {
  if (maxCredits !== undefined && cost > maxCredits) {
    throw new AppError(
      400,
      ERROR_CODES.MAX_CREDITS_EXCEEDED,
      t("error.MAX_CREDITS_EXCEEDED", { cost, maxCredits }),
      { cost, maxCredits },
    );
  }
}

export function isPolicyErrorText(text: string): boolean {
  return POLICY_ERROR_RE.test(text);
}

export function isCreditExhaustedText(text: string): boolean {
  if (!text || POLICY_ERROR_RE.test(text)) return false;
  return CREDIT_EXHAUSTED_RE.test(text);
}

export function classifyTileFailure(reason: string): "policy" | "credit_exhausted" | "other" {
  if (isPolicyErrorText(reason)) return "policy";
  if (isCreditExhaustedText(reason)) return "credit_exhausted";
  return "other";
}

export async function evaluatePreSubmitCredits(opts: {
  cost: number;
  maxCredits?: number;
  readBalance: () => Promise<number | undefined>;
  hasInsufficientUi: () => Promise<boolean>;
}): Promise<{ creditsRemaining?: number }> {
  assertWithinMaxCredits(opts.cost, opts.maxCredits);
  if (opts.cost <= 0) return {};

  const blockedUi = await opts.hasInsufficientUi();
  const creditsRemaining = await opts.readBalance();
  if (blockedUi || (creditsRemaining !== undefined && creditsRemaining < opts.cost)) {
    const reason =
      creditsRemaining !== undefined
        ? `Flow quotes ${opts.cost} credits, but account has ${creditsRemaining} credits remaining.`
        : `Flow reported insufficient credits for a ${opts.cost}-credit generation.`;
    throw new CreditExhaustedError({
      requiredCost: opts.cost,
      creditsRemaining,
      reason,
    });
  }
  return { creditsRemaining };
}
