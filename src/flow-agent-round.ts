import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import {
  attachAsset,
  closeAgentSession,
  collectAndDownload,
  collectionFor,
  downloadPace,
  downloadTile,
  ensureProjectGrid,
  errorReason,
  hasInsufficientCreditsUi,
  mediaTile,
  pause,
  readCredits,
  retryNewErrorTiles,
  scanGrid,
  scrollToTop,
  step,
} from "./flow.js";
import { buildAgentScript, matchScenes, sceneNumberOf } from "./flow-agent-plan.js";
import { CreditExhaustedError, isCreditExhaustedText } from "./flow-credits.js";
import type { Job } from "./queue.js";

export interface RoundOutcome {
  produced: number;
  timedOut: boolean;
  failedTiles: number;
  reply?: string;
}

export async function agentRound(
  page: Page,
  job: Job,
  scenes: string[],
  indexes: number[],
  retry: boolean,
  files: string[],
  done: Set<number>,
): Promise<RoundOutcome> {
  const s = job.params;
  await ensureProjectGrid(page);
  const seenBefore = await scanGrid(page);
  const before = new Set<string>(seenBefore.map((a) => a.id).filter((v): v is string => Boolean(v)));
  const beforeNames = new Set<string>(seenBefore.filter((a) => !a.id).map((a) => a.name));
  await scrollToTop(page);

  const clear = page.getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click();

  const refs = s.agent_refs ?? [];
  const assets = s.agent_ref_assets ?? [];
  if (refs.length) {
    for (const [k, name] of assets.entries()) {
      step(job, `attaching reference ${k + 1} of ${assets.length}`);
      await attachAsset(page, page.getByRole("button", { name: "Add ingredients to the prompt box" }), name);
      await pause(page, 700);
    }
    const attached = await page.getByRole("button", { name: "Ingredient" }).count();
    if (attached < assets.length) throw new Error(`Only ${attached} of ${assets.length} reference image(s) attached in the agent composer.`);
  }

  const ask = buildAgentScript(s, indexes, retry);
  await page.locator(".ProseMirror").first().click();
  await page.keyboard.insertText(ask);
  await pause(page, 800);

  const start = page.getByRole("button", { name: "Start generation" });
  if (!(await start.isEnabled())) {
    if (await hasInsufficientCreditsUi(page)) {
      const creditsRemaining = await readCredits(page).catch(() => undefined);
      throw new CreditExhaustedError({
        creditsRemaining,
        reason: "Flow agent disabled Start generation due to insufficient credits.",
      });
    }
    throw new Error("Flow's agent did not accept the script (Start generation stayed disabled).");
  }

  const textBefore = new Set((await page.locator("body").innerText().catch(() => "")).split("\n").map((l) => l.trim()));
  await start.click();

  const deadline = Date.now() + (3 * 60_000 + indexes.length * 30_000);
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  let idleSince = 0;
  let timedOut = false;
  for (;;) {
    await pause(page, 3000);
    const main = await page.locator("main").first().innerText();
    const pending = main.match(/\d+%/g) ?? [];
    const working = pending.length > 0 || (await stop.isVisible().catch(() => false));
    step(job, working ? (pending.length ? `${pending.length} rendering` : "the agent is working") : "the agent has finished");
    if (working) idleSince = 0;
    else if (!idleSince) idleSince = Date.now();
    else if (Date.now() - idleSince > 8000) break;
    if (Date.now() > deadline) {
      timedOut = true;
      if (await stop.isVisible().catch(() => false)) await stop.click().catch(() => {});
      await pause(page, 2000);
      break;
    }
  }

  step(job, "checking for failed tiles");
  const failedTiles = await retryNewErrorTiles(page, before, true)
    .then((r) => r.errors)
    .catch(() => 0);
  const tileReason = failedTiles > 0 ? await errorReason(page) : "";
  const fresh = (await scanGrid(page)).filter((t) => t.id && !before.has(t.id) && !beforeNames.has(t.name) && t.kind === "image");

  if (!fresh.length) {
    const reply = (await page.locator("body").innerText().catch(() => ""))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 25 && !textBefore.has(l) && !/^\d+%/.test(l) && !l.startsWith("Generate exactly") && !l.includes("Scene 1"))
      .join(" ")
      .slice(0, 600);
    const uiExhausted = await hasInsufficientCreditsUi(page);
    await closeAgentSession(page);
    if ((tileReason && isCreditExhaustedText(tileReason)) || (reply && isCreditExhaustedText(reply)) || uiExhausted) {
      const creditsRemaining = await readCredits(page).catch(() => undefined);
      throw new CreditExhaustedError({
        creditsRemaining,
        reason: tileReason || reply || "Flow agent reported insufficient credits.",
      });
    }
    return { produced: 0, timedOut, failedTiles, reply: reply || undefined };
  }

  const prompts: string[] = [];
  for (const [k, tile] of fresh.entries()) {
    step(job, `matching image ${k + 1} of ${fresh.length} to its scene`);
    await scanGrid(page, (seen) => seen.some((x) => x.id === tile.id));
    const el = mediaTile(page, tile.id!);
    await el.scrollIntoViewIfNeeded();
    await el.hover();
    await el.getByRole("button", { name: "Reuse prompt" }).click();
    await pause(page, 900);
    prompts.push(await page.locator(".ProseMirror").first().innerText());
  }
  await closeAgentSession(page);

  const assigned = matchScenes(
    indexes.map((i) => scenes[i]),
    prompts,
  );
  const drop = Number(process.env.FLOW_MCP_SIMULATE_MISSING ?? 0);
  mkdirSync(s.output_dir, { recursive: true });
  const wanted: { scene: number; id: string; stem: string }[] = [];
  for (const [n, tileIndexes] of assigned.entries()) {
    const sceneIndex = indexes[n];
    const num = sceneNumberOf(s, sceneIndex);
    if (!tileIndexes.length || (num === drop && !s.agent_numbers)) continue;
    for (const [v, tileIndex] of tileIndexes.entries()) {
      wanted.push({
        scene: sceneIndex,
        id: fresh[tileIndex].id!,
        stem: join(s.output_dir, `scene-${String(num).padStart(2, "0")}${v ? `-v${v + 1}` : ""}`),
      });
    }
  }

  let produced = 0;
  if ((s.download_quality ?? "original") === "original" && wanted.length) {
    const saved = await collectAndDownload(page, job, collectionFor(job), wanted);
    files.push(...saved.values());
  } else {
    for (const w of wanted) {
      const started = Date.now();
      if (!(await mediaTile(page, w.id).count())) await scanGrid(page, (seen) => seen.some((x) => x.id === w.id));
      step(job, `downloading scene ${sceneNumberOf(s, w.scene)}`);
      files.push(...(await downloadTile(page, mediaTile(page, w.id), w.stem, s.download_quality ?? "original")));
      await pause(page, Math.max(0, downloadPace() - (Date.now() - started)));
    }
  }

  for (const scene of new Set(wanted.map((w) => w.scene))) {
    done.add(scene);
    produced++;
  }
  return { produced, timedOut, failedTiles };
}
