import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createTranslator, flattenLocale, type StudioMutableState, type StudioSlotRef } from "../dist/studio/account-state.js";
import {
  clearMismatchedOnSurface,
  deriveActiveTabRollBlock,
  deriveCastImageMismatch,
  deriveSurfaceMismatch,
  getSlotDisplayInfo,
  isSlotMismatched,
  preserveAndTagDrafts,
  stampSlotAccount,
  summarizeMismatchedSlots,
} from "../dist/studio/draft-guards.js";

const rawEn = JSON.parse(readFileSync(join(process.cwd(), "src/locales/en.json"), "utf8")) as unknown;
const t = createTranslator(flattenLocale(rawEn));

test("stampSlotAccount, isSlotMismatched, and preserveAndTagDrafts tag asset slots without deleting drafts", () => {
  assert.equal(stampSlotAccount(null, { id: "a1", label: "Primary" }), null);
  const localSlot: StudioSlotRef = { path: "/tmp/local.png", name: "local.png" };
  assert.equal(stampSlotAccount(localSlot, { id: "a1", label: "Primary" }), localSlot);
  const assetSlot: StudioSlotRef = { asset: "Hero" };
  assert.equal(stampSlotAccount(assetSlot, null), assetSlot);
  assert.deepEqual(stampSlotAccount(assetSlot, { id: "a1", label: "Primary" }), {
    asset: "Hero",
    assetAccountId: "a1",
    assetAccountLabel: "Primary",
  });
  assert.deepEqual(stampSlotAccount(assetSlot, { id: "a1" }), {
    asset: "Hero",
    assetAccountId: "a1",
  });

  assert.equal(isSlotMismatched(null, "a2"), false);
  assert.equal(isSlotMismatched(localSlot, "a2"), false);
  assert.equal(isSlotMismatched(assetSlot, null), false);
  assert.equal(isSlotMismatched({ asset: "Hero", assetAccountId: "a2" }, "a2"), false);
  assert.equal(isSlotMismatched({ asset: "Hero", assetAccountId: "a1" }, "a2"), true);
  assert.equal(isSlotMismatched({ asset: "LegacyHero" }, "a2"), true);

  const state: StudioMutableState = {
    tab: "frames",
    frames: {
      engine: "exact",
      scenes: [
        {
          prompt: "Frame 1",
          first: { asset: "Hero" },
          last: { path: "/tmp/keep.png" },
          refs: [{ asset: "AlreadyTagged", assetAccountId: "a0", assetAccountLabel: "Old" }, { path: "/tmp/ref.png" }],
        },
      ],
    },
    shots: {
      scenes: [
        {
          prompt: "Shot 1",
          first: { asset: "StartAsset" },
          last: { asset: "EndAsset" },
          refs: [{ asset: "ShotRef" }],
        },
      ],
    },
  };
  const castImg: StudioSlotRef = { asset: "CastPic" };
  const res = preserveAndTagDrafts(state, castImg, { id: "a1", label: "Primary" });
  assert.equal(res.preservedAssets, 6);
  assert.deepEqual(state.frames.scenes[0].first, { asset: "Hero", assetAccountId: "a1", assetAccountLabel: "Primary" });
  assert.deepEqual(state.frames.scenes[0].refs[0], { asset: "AlreadyTagged", assetAccountId: "a0", assetAccountLabel: "Old" });
  assert.deepEqual(state.shots.scenes[0].first, { asset: "StartAsset", assetAccountId: "a1", assetAccountLabel: "Primary" });
  assert.deepEqual(state.shots.scenes[0].last, { asset: "EndAsset", assetAccountId: "a1", assetAccountLabel: "Primary" });
  assert.deepEqual(state.shots.scenes[0].refs[0], { asset: "ShotRef", assetAccountId: "a1", assetAccountLabel: "Primary" });
  assert.deepEqual(castImg, { asset: "CastPic", assetAccountId: "a1", assetAccountLabel: "Primary" });

  // Legacy unknown-origin stays untagged when prevAccount is null; prevAccount without label omits label
  const legacyState: StudioMutableState = {
    frames: { scenes: [{ first: { asset: "Legacy" }, last: null, refs: [] }] },
    shots: { scenes: [{ first: null, last: null, refs: [] }] },
  };
  const legacyRes = preserveAndTagDrafts(legacyState, { path: "/tmp/local.png" }, null);
  assert.equal(legacyRes.preservedAssets, 1);
  assert.deepEqual(legacyState.frames.scenes[0].first, { asset: "Legacy" });

  const noLabelState: StudioMutableState = {
    frames: { scenes: [{ first: { asset: "Unlabeled" }, last: null, refs: [] }] },
    shots: { scenes: [] },
  };
  preserveAndTagDrafts(noLabelState, null, { id: "a3" });
  assert.deepEqual(noLabelState.frames.scenes[0].first, { asset: "Unlabeled", assetAccountId: "a3" });
});

test("summarizeMismatchedSlots, deriveSurfaceMismatch, roll/cast gating, clearMismatchedOnSurface, and slot display", () => {
  assert.equal(summarizeMismatchedSlots([], "a2", "Backup 1", t), null);

  const singleKnown = summarizeMismatchedSlots(
    [{ asset: "H1", assetAccountId: "a1", assetAccountLabel: "Primary" }],
    "a2",
    "Backup 1",
    t,
  );
  assert.deepEqual(singleKnown, {
    sourceLabels: '"Primary"',
    switchTarget: { id: "a1", label: "Primary" },
    activeLabel: "Backup 1",
  });

  const twoSources = summarizeMismatchedSlots(
    [
      { asset: "H1", assetAccountId: "a1" },
      { asset: "H2", assetAccountId: "a3", assetAccountLabel: "Studio 3" },
    ],
    "a2",
    null,
    t,
  );
  assert.deepEqual(twoSources, {
    sourceLabels: '"a1" and "Studio 3"',
    switchTarget: null,
    activeLabel: "a2",
  });

  const threeWithUnknown = summarizeMismatchedSlots(
    [
      { asset: "H1", assetAccountId: "a1", assetAccountLabel: "Primary" },
      { asset: "H2", assetAccountId: "a3", assetAccountLabel: "Studio 3" },
      { asset: "Legacy" },
    ],
    "a2",
    "Backup 1",
    t,
  );
  assert.deepEqual(threeWithUnknown, {
    sourceLabels: '"Primary", "Studio 3", and previous account',
    switchTarget: null,
    activeLabel: "Backup 1",
  });

  const unknownOnly = summarizeMismatchedSlots([{ asset: "Legacy" }], null, null, t);
  assert.equal(unknownOnly, null);
  const unknownActive = summarizeMismatchedSlots([{ asset: "Legacy" }], "", null, t);
  assert.equal(unknownActive, null);

  const state: StudioMutableState = {
    tab: "frames",
    frames: {
      engine: "exact",
      scenes: [
        { prompt: "   ", first: null, last: null, refs: [{ asset: "DraftOnly", assetAccountId: "a1", assetAccountLabel: "Primary" }] },
        { prompt: "Draw hero", first: null, last: null, refs: [{ asset: "Hero", assetAccountId: "a1", assetAccountLabel: "Primary" }] },
      ],
    },
    shots: {
      scenes: [
        { prompt: "   ", chain: false, first: { asset: "IgnoredEmpty", assetAccountId: "a1", assetAccountLabel: "Primary" }, last: null, refs: [] },
        { prompt: "Shot 2", chain: true, first: { asset: "ChainedIgnored", assetAccountId: "a1", assetAccountLabel: "Primary" }, last: null, refs: [] },
      ],
    },
  };

  assert.equal(deriveSurfaceMismatch("frames", state, null, "a2", "Backup 1", t)?.sourceLabels, '"Primary"');
  assert.equal(deriveSurfaceMismatch("shots", state, null, "a2", "Backup 1", t)?.sourceLabels, '"Primary"');
  assert.equal(deriveSurfaceMismatch("shots", state, null, "a2", "Backup 1", t)?.switchTarget?.id, "a1");
  assert.equal(deriveSurfaceMismatch("cast", state, { asset: "CastPic", assetAccountId: "a1", assetAccountLabel: "Primary" }, "a2", "Backup 1", t)?.sourceLabels, '"Primary"');

  // Active-tab #roll gating
  assert.equal(deriveActiveTabRollBlock("cast", state, "a2", "Backup 1", t), null);
  assert.equal(deriveActiveTabRollBlock("frames", { ...state, frames: { ...state.frames, engine: "agent" } }, "a2", "Backup 1", t), null);
  assert.equal(deriveActiveTabRollBlock("frames", state, "a2", "Backup 1", t)?.sourceLabels, '"Primary"');
  assert.equal(deriveActiveTabRollBlock("frames", { ...state, frames: { engine: "exact", scenes: [state.frames.scenes[0]] } }, "a2", "Backup 1", t), null);
  assert.equal(deriveActiveTabRollBlock("shots", state, "a2", "Backup 1", t), null);

  state.shots.scenes[1].last = { asset: "EndClip", assetAccountId: "a1", assetAccountLabel: "Primary" };
  assert.equal(deriveActiveTabRollBlock("shots", state, "a2", "Backup 1", t)?.sourceLabels, '"Primary"');

  // Cast mismatch gating
  assert.equal(deriveCastImageMismatch(null, "a2", "Backup 1", t), null);
  assert.equal(
    deriveCastImageMismatch({ asset: "CastPic", assetAccountId: "a1", assetAccountLabel: "Primary" }, "a2", "Backup 1", t)?.blockedReason,
    t("account.drafts.castBlockedReason", { sourceLabels: '"Primary"' }),
  );
  const studioHtml = readFileSync(join(process.cwd(), "studio/index.html"), "utf8");
  assert.ok(studioHtml.includes('id="castCreateHint"'));
  assert.ok(studioHtml.includes("castBlock.blockedReason"));
  assert.ok(studioHtml.includes('setAttribute("aria-describedby", "castCreateHint")'));

  // Clear mismatched assets per surface without touching other surfaces or local/matching refs
  const activeMatchingCast: StudioSlotRef = { asset: "CastOk", assetAccountId: "a2", assetAccountLabel: "Backup 1" };
  assert.equal(clearMismatchedOnSurface("cast", state, { asset: "CastBad", assetAccountId: "a1" }, "a2"), null);
  assert.equal(clearMismatchedOnSurface("cast", state, activeMatchingCast, "a2"), activeMatchingCast);

  state.frames.scenes[0].first = { asset: "MismatchFirst", assetAccountId: "a1" };
  state.frames.scenes[0].last = { asset: "MismatchLast", assetAccountId: "a1" };
  state.frames.scenes[1].refs.push({ path: "/tmp/local.png" }, { asset: "Ok", assetAccountId: "a2" });
  clearMismatchedOnSurface("frames", state, activeMatchingCast, "a2");
  assert.equal(state.frames.scenes[0].first, null);
  assert.equal(state.frames.scenes[0].last, null);
  assert.deepEqual(state.frames.scenes[1].refs, [{ path: "/tmp/local.png" }, { asset: "Ok", assetAccountId: "a2" }]);
  assert.ok(state.shots.scenes[1].last); // untouched by frames clear
  clearMismatchedOnSurface("shots", state, activeMatchingCast, "a2");
  assert.equal(state.shots.scenes[1].last, null);

  // Slot display info
  assert.deepEqual(getSlotDisplayInfo({ path: "/tmp/a.png" }, "a2", t), {
    mismatched: false,
    badgeText: null,
    clearAria: t("account.drafts.clearSlotGenericAria"),
  });
  assert.deepEqual(getSlotDisplayInfo({ asset: "Hero", assetAccountId: "a1", assetAccountLabel: "Primary" }, "a2", t), {
    mismatched: true,
    badgeText: "From Primary",
    clearAria: "Remove Hero from Primary",
  });
  assert.deepEqual(getSlotDisplayInfo({ asset: "Legacy" }, "a2", t), {
    mismatched: true,
    badgeText: "From previous account",
    clearAria: t("account.drafts.clearSlotGenericAria"),
  });
});
