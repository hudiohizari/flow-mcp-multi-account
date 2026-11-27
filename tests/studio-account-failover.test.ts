import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  EXHAUSTION_TTL_MS,
  deriveAccountCreditMeta,
  formatFailoverTrail,
  getFailoverPhaseCopy,
  isWithinFailoverTtl,
  syncFailoverControl,
} from "../dist/studio/account-failover.js";
import { createTranslator, flattenLocale, type AccountItem, type ElementLike, type EventLike } from "../dist/studio/account-state.js";

const rawEn = JSON.parse(readFileSync(join(process.cwd(), "src/locales/en.json"), "utf8")) as unknown;
const t = createTranslator(flattenLocale(rawEn));

function makeAcc(overrides: Partial<AccountItem> = {}): AccountItem {
  return {
    id: "default",
    slug: "default",
    label: "Primary",
    isDefault: true,
    enabled: true,
    priority: 1,
    active: true,
    needsRelogin: false,
    ...overrides,
  };
}

class StubEl implements ElementLike {
  id: string;
  hidden = false;
  disabled = false;
  value = "";
  textContent: string | null = "";
  innerHTML = "";
  open = false;
  attrs = new Map<string, string>();
  constructor(id: string) {
    this.id = id;
  }
  closest(): ElementLike | null { return null; }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  focus(): void {}
  addEventListener(_t: string, _l: (ev: EventLike) => void): void {}
  showModal(): void { this.open = true; }
  close(): void { this.open = false; }
}

test("isWithinFailoverTtl and deriveAccountCreditMeta enforce 24h TTL and non-stacking badges", () => {
  const now = Date.parse("2026-11-26T12:00:00.000Z");
  const freshIso = new Date(now - 3600_000).toISOString();
  const expiredIso = new Date(now - EXHAUSTION_TTL_MS).toISOString();

  assert.equal(isWithinFailoverTtl(undefined, now), false);
  assert.equal(isWithinFailoverTtl("not-a-date", now), false);
  assert.equal(isWithinFailoverTtl(freshIso, now), true);
  assert.equal(isWithinFailoverTtl(expiredIso, now), false);

  assert.deepEqual(deriveAccountCreditMeta(makeAcc({ creditsRemaining: 500, balanceUpdatedAt: freshIso }), now, t), {
    badgeText: null,
    ttlNote: null,
    detailText: null,
  });

  const zeroFresh = deriveAccountCreditMeta(makeAcc({ creditsRemaining: 0, balanceUpdatedAt: freshIso }), now, t);
  assert.equal(zeroFresh.badgeText, t("account.badges.zeroCredits"));
  assert.equal(zeroFresh.ttlNote, t("account.meta.skipZeroWithinTtl"));
  assert.ok(zeroFresh.detailText?.includes(t("account.credits.skipZeroDetail")));
  assert.ok(zeroFresh.detailText?.includes(t("account.credits.freeFramesUnaffected")));
  assert.ok(zeroFresh.detailText?.includes(t("account.credits.ttlHint")));

  // Does not stack with needsRelogin
  const zeroRelogin = deriveAccountCreditMeta(makeAcc({ creditsRemaining: 0, balanceUpdatedAt: freshIso, needsRelogin: true }), now, t);
  assert.equal(zeroRelogin.badgeText, null);
  assert.equal(zeroRelogin.ttlNote, t("account.meta.skipZeroWithinTtl"));

  const costFresh = deriveAccountCreditMeta(makeAcc({ creditsRemaining: 10, balanceUpdatedAt: freshIso, exhaustedMinCost: 15, exhaustedAt: freshIso }), now, t);
  assert.equal(costFresh.badgeText, t("account.badges.lowCredits"));
  assert.equal(costFresh.ttlNote, t("account.meta.skipCostWithinTtl", { minCost: 15 }));
  assert.ok(costFresh.detailText?.includes(t("account.credits.skipCostDetail", { minCost: 15 })));

  // Expired >= 24h clears badge and shows live-recheck guidance
  const zeroStale = deriveAccountCreditMeta(makeAcc({ creditsRemaining: 0, balanceUpdatedAt: expiredIso }), now, t);
  assert.equal(zeroStale.badgeText, null);
  assert.equal(zeroStale.ttlNote, t("account.meta.recheckAfterTtl"));
  assert.ok(zeroStale.detailText?.includes(t("account.credits.staleRecheckNote")));

  const costStale = deriveAccountCreditMeta(makeAcc({ exhaustedMinCost: 20, exhaustedAt: expiredIso }), now, t);
  assert.equal(costStale.badgeText, null);
  assert.equal(costStale.ttlNote, t("account.meta.recheckAfterTtl"));
});

test("getFailoverPhaseCopy and formatFailoverTrail cover all stages, skip reasons, and hop formats", () => {
  const evalCopy = getFailoverPhaseCopy({ stage: "evaluating", fromAccountId: "a1", fromLabel: "Primary", startedAt: "now" }, t);
  assert.equal(evalCopy.pillText, t("account.failover.pillEvaluating"));

  const switchCopy = getFailoverPhaseCopy(
    { stage: "switching", fromAccountId: "a1", fromLabel: "Primary", toAccountId: "a2", toLabel: "Backup 1", startedAt: "now" },
    t,
  );
  assert.ok(switchCopy.heading.includes("Backup 1"));

  const switchNoTarget = getFailoverPhaseCopy({ stage: "switching", fromAccountId: "a1", fromLabel: "Primary", startedAt: "now" }, t);
  assert.equal(switchNoTarget.pillText, t("account.failover.pillSwitching", { toLabel: "" }));

  const verifyCopy = getFailoverPhaseCopy(
    { stage: "verifying", fromAccountId: "a1", fromLabel: "Primary", toAccountId: "a2", toLabel: "Backup 1", startedAt: "now" },
    t,
  );
  assert.ok(verifyCopy.description.includes("Backup 1"));

  const revertCopy = getFailoverPhaseCopy({ stage: "reverting", fromAccountId: "a1", fromLabel: "Primary", startedAt: "now" }, t);
  assert.ok(revertCopy.heading.includes("Primary"));

  assert.equal(formatFailoverTrail(undefined, t), null);
  assert.equal(formatFailoverTrail([], t), null);

  const trail = formatFailoverTrail(
    [
      { accountId: "a2", accountLabel: "Backup 1", status: "skipped", reason: "disabled" },
      { accountId: "a3", accountLabel: "Backup 2", status: "failed", reason: "Needs sign-in" },
      { accountId: "a4", accountLabel: "Backup 3", status: "succeeded", reason: "" },
    ],
    t,
  );
  assert.ok(trail?.includes("Backup 1 (skipped: disabled)"));
  assert.ok(trail?.includes("Backup 2 (failed: Needs sign-in)"));
  assert.ok(trail?.includes("Backup 3 (succeeded)"));
});

test("syncFailoverControl updates toggle, aria-describedby, empty/lock notes in place across all states", () => {
  const row = new StubEl("accFailoverRow");
  const toggle = new StubEl("accFailoverToggle");
  const emptyNote = new StubEl("accFailoverEmptyNote");
  const lockReason = new StubEl("accFailoverLockReason");
  const dom = { row, toggle, emptyNote, lockReason };

  const primary = makeAcc();
  syncFailoverControl(dom, {
    view: { kind: "error", message: "bad", code: "REGISTRY_CORRUPT", accounts: [], activeAccountId: null },
    autoFailover: true,
    enabledCount: 1,
    busy: false,
    inFlight: null,
    t,
  });
  assert.equal(row.hidden, true);

  syncFailoverControl(dom, {
    view: { kind: "loading" },
    autoFailover: true,
    enabledCount: 0,
    busy: false,
    inFlight: null,
    t,
  });
  assert.equal(row.hidden, false);
  assert.equal(toggle.disabled, true);
  assert.equal(emptyNote.hidden, true);
  assert.equal(lockReason.hidden, true);
  assert.equal(toggle.getAttribute("aria-describedby"), "accFailoverHelper");

  // Empty state (<= 1 enabled) remains interactive
  syncFailoverControl(dom, {
    view: { kind: "empty", accounts: [primary], activeAccount: primary },
    autoFailover: false,
    enabledCount: 1,
    busy: false,
    inFlight: null,
    t,
  });
  assert.equal(toggle.disabled, false);
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  assert.equal(emptyNote.hidden, false);
  assert.equal(toggle.getAttribute("aria-describedby"), "accFailoverHelper accFailoverEmptyNote");

  // Populated + busy lock
  syncFailoverControl(dom, {
    view: { kind: "populated", accounts: [primary, makeAcc({ id: "b1", label: "B1", active: false })], activeAccount: primary },
    autoFailover: true,
    enabledCount: 2,
    busy: true,
    inFlight: null,
    t,
  });
  assert.equal(toggle.disabled, true);
  assert.equal(emptyNote.hidden, true);
  assert.equal(lockReason.hidden, false);
  assert.equal(lockReason.textContent, t("account.failover.lockedBusy"));
  assert.equal(toggle.getAttribute("aria-describedby"), "accFailoverHelper accFailoverLockReason");

  // Switching lock
  syncFailoverControl(dom, {
    view: { kind: "switching", accounts: [primary], activeAccountId: "default", targetId: "b1" },
    autoFailover: true,
    enabledCount: 2,
    busy: false,
    inFlight: null,
    t,
  });
  assert.equal(lockReason.textContent, t("account.failover.lockedSwitching"));

  // Pessimistic in-flight failoverConfig sets aria-busy without changing aria-checked
  syncFailoverControl(dom, {
    view: { kind: "populated", accounts: [primary, makeAcc({ id: "b1", label: "B1", active: false })], activeAccount: primary },
    autoFailover: true,
    enabledCount: 2,
    busy: false,
    inFlight: { kind: "failoverConfig", id: null },
    t,
  });
  assert.equal(toggle.disabled, true);
  assert.equal(toggle.getAttribute("aria-busy"), "true");
  assert.equal(lockReason.hidden, true);

  // Other in-flight ops (refresh / switch) show appropriate lock reason
  syncFailoverControl(dom, {
    view: { kind: "populated", accounts: [primary, makeAcc({ id: "b1", label: "B1", active: false })], activeAccount: primary },
    autoFailover: true,
    enabledCount: 2,
    busy: false,
    inFlight: { kind: "refresh", id: "default" },
    t,
  });
  assert.equal(toggle.getAttribute("aria-busy"), null);
  assert.equal(lockReason.textContent, t("account.failover.lockedBusy"));

  syncFailoverControl(dom, {
    view: { kind: "populated", accounts: [primary, makeAcc({ id: "b1", label: "B1", active: false })], activeAccount: primary },
    autoFailover: true,
    enabledCount: 2,
    busy: false,
    inFlight: { kind: "switch", id: "b1" },
    t,
  });
  assert.equal(lockReason.textContent, t("account.failover.lockedSwitching"));
});
