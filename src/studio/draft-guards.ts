import type { StudioMutableState, StudioScene, StudioSlotRef, Translator } from "./account-types.js";

export interface DraftSurfaceMismatch {
  sourceLabels: string;
  switchTarget: { id: string; label: string } | null;
  activeLabel: string;
}

export function stampSlotAccount(slot: StudioSlotRef | null, account: { id: string; label?: string } | null): StudioSlotRef | null {
  if (!slot || !slot.asset || !account) return slot;
  return { ...slot, assetAccountId: account.id, ...(account.label ? { assetAccountLabel: account.label } : {}) };
}

export function isSlotMismatched(slot: StudioSlotRef | null, activeAccountId: string | null): boolean {
  return Boolean(slot && slot.asset && activeAccountId && slot.assetAccountId !== activeAccountId);
}

export function preserveAndTagDrafts(
  state: StudioMutableState,
  castImage: StudioSlotRef | null,
  prevAccount: { id: string; label?: string } | null,
): { preservedAssets: number } {
  let preservedAssets = 0;
  const tag = (slot: StudioSlotRef | null): void => {
    if (!slot || !slot.asset) return;
    preservedAssets++;
    if (!slot.assetAccountId && prevAccount) {
      slot.assetAccountId = prevAccount.id;
      if (prevAccount.label) slot.assetAccountLabel = prevAccount.label;
    }
  };
  for (const sc of [...state.frames.scenes, ...state.shots.scenes]) {
    tag(sc.first);
    tag(sc.last);
    for (const ref of sc.refs) tag(ref);
  }
  tag(castImage);
  return { preservedAssets };
}

function formatSourceLabels(labels: string[]): string {
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

export function summarizeMismatchedSlots(
  slots: (StudioSlotRef | null)[],
  activeAccountId: string | null,
  activeAccountLabel: string | null,
  t: Translator,
): DraftSurfaceMismatch | null {
  const mismatched = slots.filter((s): s is StudioSlotRef => isSlotMismatched(s, activeAccountId));
  if (mismatched.length === 0) return null;
  const known = new Map<string, string>();
  let hasUnknown = false;
  for (const s of mismatched) {
    if (s.assetAccountId) known.set(s.assetAccountId, s.assetAccountLabel || s.assetAccountId);
    else hasUnknown = true;
  }
  const parts = [...known.values()].map((label) => `"${label}"`);
  if (hasUnknown) parts.push(t("account.drafts.previousAccountFallback"));
  const entries = [...known.entries()];
  const switchTarget = entries.length === 1 && !hasUnknown ? { id: entries[0][0], label: entries[0][1] } : null;
  return { sourceLabels: formatSourceLabels(parts), switchTarget, activeLabel: activeAccountLabel || activeAccountId! };
}

function collectSceneSlots(scenes: StudioScene[], submittableOnly: boolean, ignoreChainedFirst: boolean): (StudioSlotRef | null)[] {
  const out: (StudioSlotRef | null)[] = [];
  for (const sc of scenes) {
    if (submittableOnly && !sc.prompt?.trim()) continue;
    out.push(ignoreChainedFirst && sc.chain ? null : sc.first, sc.last, ...sc.refs);
  }
  return out;
}

export function deriveSurfaceMismatch(
  surface: "frames" | "shots" | "cast",
  state: StudioMutableState,
  castImage: StudioSlotRef | null,
  activeId: string | null,
  activeLabel: string | null,
  t: Translator,
): DraftSurfaceMismatch | null {
  const slots = surface === "cast" ? [castImage] : collectSceneSlots((surface === "frames" ? state.frames : state.shots).scenes, false, surface === "shots");
  return summarizeMismatchedSlots(slots, activeId, activeLabel, t);
}

export function deriveActiveTabRollBlock(
  tab: string | undefined,
  state: StudioMutableState,
  activeId: string | null,
  activeLabel: string | null,
  t: Translator,
): { sourceLabels: string; blockedReason: string } | null {
  if ((tab !== "frames" && tab !== "shots") || (tab === "frames" && state.frames.engine === "agent")) return null;
  const slots = collectSceneSlots((tab === "frames" ? state.frames : state.shots).scenes, true, tab === "shots");
  const m = summarizeMismatchedSlots(slots, activeId, activeLabel, t);
  return m ? { sourceLabels: m.sourceLabels, blockedReason: t("account.drafts.rollBlockedReason", { sourceLabels: m.sourceLabels }) } : null;
}

export function deriveCastImageMismatch(castImage: StudioSlotRef | null, activeId: string | null, activeLabel: string | null, t: Translator): (DraftSurfaceMismatch & { blockedReason: string }) | null {
  const m = summarizeMismatchedSlots([castImage], activeId, activeLabel, t);
  return m ? { ...m, blockedReason: t("account.drafts.castBlockedReason", { sourceLabels: m.sourceLabels }) } : null;
}

export function clearMismatchedOnSurface(surface: "frames" | "shots" | "cast", state: StudioMutableState, castImage: StudioSlotRef | null, activeId: string | null): StudioSlotRef | null {
  if (surface === "cast") return isSlotMismatched(castImage, activeId) ? null : castImage;
  for (const sc of (surface === "frames" ? state.frames : state.shots).scenes) {
    if (isSlotMismatched(sc.first, activeId)) sc.first = null;
    if (isSlotMismatched(sc.last, activeId)) sc.last = null;
    sc.refs = sc.refs.filter((r) => !isSlotMismatched(r, activeId));
  }
  return castImage;
}

export function getSlotDisplayInfo(slot: StudioSlotRef | null, activeId: string | null, t: Translator): { mismatched: boolean; badgeText: string | null; clearAria: string } {
  if (!isSlotMismatched(slot, activeId)) return { mismatched: false, badgeText: null, clearAria: t("account.drafts.clearSlotGenericAria") };
  const label = slot!.assetAccountLabel;
  return {
    mismatched: true,
    badgeText: t("account.drafts.slotBadge", { label: label || t("account.drafts.previousAccountFallback") }),
    clearAria: label ? t("account.drafts.clearSlotAria", { name: slot!.asset!, label }) : t("account.drafts.clearSlotGenericAria"),
  };
}
