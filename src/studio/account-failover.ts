import type {
  AccountItem,
  AccountsViewState,
  ElementLike,
  FailoverAttempt,
  FailoverPhaseInfo,
  InFlightAccountOp,
  Translator,
} from "./account-types.js";

export const EXHAUSTION_TTL_MS = 86_400_000;

const HOP_STATUS_KEYS: Record<FailoverAttempt["status"], string> = {
  skipped: "account.monitor.hopStatusSkipped",
  failed: "account.monitor.hopStatusFailed",
  succeeded: "account.monitor.hopStatusSucceeded",
};

const SKIP_REASON_KEYS: Record<string, string> = {
  already_attempted: "account.failover.skipReasons.already_attempted",
  disabled: "account.failover.skipReasons.disabled",
  needs_relogin: "account.failover.skipReasons.needs_relogin",
  insufficient_cached_credits: "account.failover.skipReasons.insufficient_cached_credits",
  recently_exhausted: "account.failover.skipReasons.recently_exhausted",
};

export function isWithinFailoverTtl(iso: string | undefined, nowMs: number): boolean {
  if (!iso) return false;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return false;
  return nowMs - ms < EXHAUSTION_TTL_MS;
}

export function deriveAccountCreditMeta(
  acc: AccountItem,
  nowMs: number,
  t: Translator,
): { badgeText: string | null; ttlNote: string | null; detailText: string | null } {
  const zeroFresh = acc.creditsRemaining === 0 && isWithinFailoverTtl(acc.balanceUpdatedAt, nowMs);
  const costFresh = !zeroFresh && acc.exhaustedMinCost !== undefined && isWithinFailoverTtl(acc.exhaustedAt, nowMs);
  const staleFlagged = !zeroFresh && !costFresh && (acc.creditsRemaining === 0 || acc.exhaustedMinCost !== undefined);

  let badgeText: string | null = null;
  if (!acc.needsRelogin) {
    if (zeroFresh) badgeText = t("account.badges.zeroCredits");
    else if (costFresh) badgeText = t("account.badges.lowCredits");
  }

  let ttlNote: string | null = null;
  let detailNote: string | null = null;
  if (zeroFresh) {
    ttlNote = t("account.meta.skipZeroWithinTtl");
    detailNote = t("account.credits.skipZeroDetail");
  } else if (costFresh) {
    const minCost = acc.exhaustedMinCost!;
    ttlNote = t("account.meta.skipCostWithinTtl", { minCost });
    detailNote = t("account.credits.skipCostDetail", { minCost });
  } else if (staleFlagged) {
    ttlNote = t("account.meta.recheckAfterTtl");
    detailNote = t("account.credits.staleRecheckNote");
  }

  const detailText = detailNote
    ? `${detailNote} ${t("account.credits.freeFramesUnaffected")} ${t("account.credits.ttlHint")}`
    : null;
  return { badgeText, ttlNote, detailText };
}

export function getFailoverPhaseCopy(
  phase: FailoverPhaseInfo,
  t: Translator,
): { pillText: string; heading: string; description: string } {
  const toLabel = phase.toLabel || "";
  if (phase.stage === "evaluating") {
    return {
      pillText: t("account.failover.pillEvaluating"),
      heading: t("account.failover.phases.evaluating.heading"),
      description: t("account.failover.phases.evaluating.description", { fromLabel: phase.fromLabel }),
    };
  }
  if (phase.stage === "switching") {
    return {
      pillText: t("account.failover.pillSwitching", { toLabel }),
      heading: t("account.failover.phases.switching.heading", { toLabel }),
      description: t("account.failover.phases.switching.description", { fromLabel: phase.fromLabel, toLabel }),
    };
  }
  if (phase.stage === "verifying") {
    return {
      pillText: t("account.failover.pillVerifying", { toLabel }),
      heading: t("account.failover.phases.verifying.heading", { toLabel }),
      description: t("account.failover.phases.verifying.description", { toLabel }),
    };
  }
  return {
    pillText: t("account.failover.pillReverting", { fromLabel: phase.fromLabel }),
    heading: t("account.failover.phases.reverting.heading", { fromLabel: phase.fromLabel }),
    description: t("account.failover.phases.reverting.description", { fromLabel: phase.fromLabel }),
  };
}

export function formatFailoverTrail(attempts: FailoverAttempt[] | undefined, t: Translator): string | null {
  if (!attempts || attempts.length === 0) return null;
  const hops = attempts.map((hop) => {
    const status = t(HOP_STATUS_KEYS[hop.status]);
    const reasonKey = SKIP_REASON_KEYS[hop.reason];
    const reason = reasonKey ? t(reasonKey) : hop.reason;
    return reason
      ? t("account.monitor.failoverHopWithReason", { label: hop.accountLabel, status, reason })
      : t("account.monitor.failoverHop", { label: hop.accountLabel, status });
  });
  return t("account.monitor.failoverTrailSummary", { trail: hops.join(", ") });
}

export function syncFailoverControl(
  dom: { row: ElementLike; toggle: ElementLike; emptyNote: ElementLike; lockReason: ElementLike },
  opts: {
    view: AccountsViewState;
    autoFailover: boolean;
    enabledCount: number;
    busy: boolean;
    inFlight: InFlightAccountOp | null;
    t: Translator;
  },
): void {
  const { view, autoFailover, enabledCount, busy, inFlight, t } = opts;
  if (view.kind === "error") {
    dom.row.hidden = true;
    return;
  }
  dom.row.hidden = false;
  const isPessimistic = inFlight !== null && inFlight.kind === "failoverConfig";
  const isSwitching = view.kind === "switching" || (inFlight !== null && inFlight.kind === "switch");
  const isLoading = view.kind === "loading";
  const locked = isLoading || isSwitching || busy || inFlight !== null;

  dom.toggle.setAttribute("aria-checked", String(autoFailover));
  dom.toggle.disabled = locked;
  if (isPessimistic) dom.toggle.setAttribute("aria-busy", "true");
  else dom.toggle.removeAttribute("aria-busy");

  const describedBy = ["accFailoverHelper"];
  const showEmpty = !isLoading && enabledCount <= 1;
  dom.emptyNote.hidden = !showEmpty;
  if (showEmpty) describedBy.push("accFailoverEmptyNote");

  let lockText: string | null = null;
  if (isSwitching) lockText = t("account.failover.lockedSwitching");
  else if (!isLoading && !isPessimistic && (busy || inFlight !== null)) lockText = t("account.failover.lockedBusy");

  if (lockText) {
    dom.lockReason.hidden = false;
    dom.lockReason.textContent = lockText;
    describedBy.push("accFailoverLockReason");
  } else {
    dom.lockReason.hidden = true;
    dom.lockReason.textContent = "";
  }
  dom.toggle.setAttribute("aria-describedby", describedBy.join(" "));
}
