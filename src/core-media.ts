import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AccountFailoverCoordinator } from "./account-failover.js";
import { assemble, voiceTrack } from "./assemble.js";
import { burnCaptions, captionedName, captionSetup, previewCaptions, transcribe } from "./captions.js";
import { extractFirstFrame, extractFrameAt, extractLastFrame } from "./chain.js";
import { getConfig, projectDir, type FlowConfig } from "./config.js";
import { AppError, ERROR_CODES } from "./errors.js";
import {
  characterLook,
  createCharacter,
  downloadAsset,
  downloadCollection,
  editCharacter,
  forgetCharacter,
  listAssets,
  rememberCharacter,
  runContinue,
  runEdit,
  runGeneration,
  trashAsset,
} from "./flow.js";
import { runAgentBatch } from "./flow-agent.js";
import type { AgentBatchResumeState } from "./flow-agent-plan.js";
import { CreditExhaustedError } from "./flow-credits.js";
import { GEMINI_VOICES, geminiKey, saveGeminiKey, speakWithGemini } from "./gemini.js";
import { KOKORO_DEFAULT_VOICE, KOKORO_MB, KOKORO_VOICES, kokoroReady, speakWithKokoro } from "./kokoro.js";
import { BIN, COMPUTER, moveToBin } from "./platform.js";
import { presenter } from "./presenter.js";
import type { Job, JobQueue } from "./queue.js";
import type { Args } from "./schemas.js";
import { techniqueById } from "./techniques.js";

export const VOICES = [
  { name: "Achernar", description: "female, soft, high pitch" },
  { name: "Achird", description: "male, friendly, mid pitch" },
  { name: "Algenib", description: "male, gravelly, low pitch" },
  { name: "Algieba", description: "male, easy-going, mid-low pitch" },
  { name: "Alnilam", description: "male, firm, mid-low pitch" },
  { name: "Aoede", description: "female, breezy, mid pitch" },
  { name: "Autonoe", description: "female, bright, mid pitch" },
  { name: "Callirrhoe", description: "female, easy-going, mid pitch" },
  { name: "Charon", description: "male, informative, lower pitch" },
  { name: "Despina", description: "female, smooth, mid pitch" },
  { name: "Enceladus", description: "male, breathy, lower pitch" },
  { name: "Erinome", description: "female, clear, mid pitch" },
  { name: "Fenrir", description: "male, excitable, younger pitch" },
  { name: "Gacrux", description: "female, mature, mid pitch" },
  { name: "Iapetus", description: "male, clear, mid-low pitch" },
];

export interface CoreMediaDeps {
  getConfig: () => FlowConfig;
  assemble: typeof assemble;
  voiceTrack: typeof voiceTrack;
  burnCaptions: typeof burnCaptions;
  captionedName: typeof captionedName;
  captionSetup: typeof captionSetup;
  previewCaptions: typeof previewCaptions;
  transcribe: typeof transcribe;
  extractFirstFrame: typeof extractFirstFrame;
  extractFrameAt: typeof extractFrameAt;
  extractLastFrame: typeof extractLastFrame;
  characterLook: typeof characterLook;
  createCharacter: typeof createCharacter;
  downloadAsset: typeof downloadAsset;
  downloadCollection: typeof downloadCollection;
  editCharacter: typeof editCharacter;
  forgetCharacter: typeof forgetCharacter;
  listAssets: typeof listAssets;
  rememberCharacter: typeof rememberCharacter;
  runAgentBatch: typeof runAgentBatch;
  runContinue: typeof runContinue;
  runEdit: typeof runEdit;
  runGeneration: typeof runGeneration;
  trashAsset: typeof trashAsset;
  geminiKey: typeof geminiKey;
  saveGeminiKey: typeof saveGeminiKey;
  speakWithGemini: typeof speakWithGemini;
  kokoroReady: typeof kokoroReady;
  speakWithKokoro: typeof speakWithKokoro;
  presenter: typeof presenter;
  moveToBin: typeof moveToBin;
}

export function defaultCoreMediaDeps(): CoreMediaDeps {
  return {
    getConfig, assemble, voiceTrack, burnCaptions, captionedName, captionSetup, previewCaptions, transcribe,
    extractFirstFrame, extractFrameAt, extractLastFrame, characterLook, createCharacter, downloadAsset,
    downloadCollection, editCharacter, forgetCharacter, listAssets, rememberCharacter, runAgentBatch,
    runContinue, runEdit, runGeneration, trashAsset, geminiKey, saveGeminiKey, speakWithGemini,
    kokoroReady, speakWithKokoro, presenter, moveToBin,
  };
}

let activeMediaDeps: CoreMediaDeps = defaultCoreMediaDeps();

export function setCoreMediaDeps(overrides?: Partial<CoreMediaDeps>): void {
  activeMediaDeps = overrides ? { ...defaultCoreMediaDeps(), ...overrides } : defaultCoreMediaDeps();
}

const words = (s: string) => s.split(/[^a-z0-9]+/i).filter((w) => w.length > 3).map((w) => w.toLowerCase());

export function nextStem(queue: JobQueue, output_dir: string, prefix: string): string {
  const onDisk = existsSync(output_dir) ? readdirSync(output_dir).map((f) => Number(f.match(new RegExp(`^${prefix}-(\\d+)`))?.[1] ?? 0)) : [];
  const queued = queue
    .list()
    .filter((j) => j.params.output_dir === output_dir && j.params.file_stem.startsWith(prefix))
    .map((j) => Number(j.params.file_stem.match(/\d+/)?.[0] ?? 0));
  return `${prefix}-${String(Math.max(0, ...onDisk, ...queued) + 1).padStart(2, "0")}`;
}

const CREDIT_EXHAUSTION_CODES: ReadonlySet<string> = new Set([
  ERROR_CODES.INSUFFICIENT_CREDITS,
  ERROR_CODES.AUTO_FAILOVER_DISABLED,
  ERROR_CODES.ACCOUNT_BOUND_FAILOVER_BLOCKED,
  ERROR_CODES.FAILOVER_EXHAUSTED,
]);

export async function runQueuedJob(
  job: Job,
  queue: JobQueue,
  deps: CoreMediaDeps,
  syncReadout: (accountId: string) => Promise<void>,
  failover?: Pick<AccountFailoverCoordinator, "prepareQueuedJob" | "executeWithFailover">,
): Promise<string[]> {
  failover?.prepareQueuedJob(job);
  const { chain_from, reference_from } = job.params;
  if (reference_from) {
    const still = queue.get(reference_from)?.files.find((f) => /\.(jpe?g|png|webp)$/i.test(f));
    if (!still) throw new Error(`reference_previous: the previous scene (${reference_from}) produced no image.`);
    if (!job.params.reference_images?.includes(still)) {
      job.params.reference_images = [still, ...(job.params.reference_images ?? [])].slice(0, 3);
    }
  }
  const ff = job.params.first_frame;
  if (ff && !ff.startsWith("asset:") && /\.(mp4|webm|mov)$/i.test(ff)) {
    job.params.first_frame = job.params.first_frame_at !== undefined ? await deps.extractFrameAt(ff, job.params.first_frame_at) : await deps.extractLastFrame(ff);
  }
  const lf = job.params.last_frame;
  if (lf && !lf.startsWith("asset:") && /\.(mp4|webm|mov)$/i.test(lf)) job.params.last_frame = await deps.extractFirstFrame(lf);
  if (chain_from && !job.params.first_frame) {
    const clip = queue.get(chain_from)?.files.find((f) => /\.(mp4|webm|mov)$/i.test(f));
    if (!clip) throw new Error(`chain_previous: the previous scene (${chain_from}) produced no video, so this scene was skipped.`);
    job.params.first_frame = await deps.extractLastFrame(clip);
  }
  const runAttempt = (resume?: AgentBatchResumeState) => {
    if (job.params.continue_from) return deps.runContinue(job);
    if (job.params.agent_scenes) return deps.runAgentBatch(job, resume);
    if (job.params.edit_asset) return deps.runEdit(job);
    return deps.runGeneration(job);
  };
  let creditExhausted = false;
  let result: string[] | undefined;
  let failure: unknown;
  let failed = false;
  try {
    result = failover ? await failover.executeWithFailover(job, runAttempt) : await runAttempt();
  } catch (err) {
    failed = true;
    failure = err;
    creditExhausted =
      err instanceof CreditExhaustedError ||
      (err instanceof AppError && CREDIT_EXHAUSTION_CODES.has(err.code));
  }
  if (job.accountId && !creditExhausted) await syncReadout(job.accountId);
  if (failed) throw failure;
  return result!;
}

export function buildSceneJobs(
  { project, scenes }: Args<"generate">,
  outputRoot: string,
  queue: JobQueue,
  owner: { id: string; label: string },
  lookFn: (name: string) => string | undefined,
): { output_dir: string; jobs: Job[] } {
  const invalid = scenes.findIndex((s, i) => s.chain_previous && (i === 0 || s.first_frame || s.type === "image"));
  if (invalid >= 0) {
    throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, `Scene ${invalid + 1}: chain_previous needs a preceding video scene in the same call and cannot be combined with first_frame.`);
  }
  const noPrev = scenes.findIndex((s, i) => s.reference_previous && i === 0);
  if (noPrev >= 0) throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, "Scene 1 has no previous scene to reference.");
  const unknown = scenes.find((s) => s.technique && !techniqueById(s.technique));
  if (unknown) throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, `Unknown technique "${unknown.technique}". Call flow_techniques for valid ids.`);

  const output_dir = projectDir(project, outputRoot);
  const onDisk = existsSync(output_dir) ? readdirSync(output_dir).map((f) => Number(f.match(/^scene-(\d+)/)?.[1] ?? 0)) : [];
  const queued = queue.list().filter((j) => j.params.output_dir === output_dir).map((j) => Number(j.params.file_stem.match(/\d+/)?.[0] ?? 0));
  const offset = Math.max(0, ...onDisk, ...queued);
  const jobs: Job[] = [];
  for (const [i, { chain_previous, reference_previous, technique, outfit, on_screen_text, ...scene }] of scenes.entries()) {
    const phrase = technique ? techniqueById(technique)!.phrase : "";
    const cast = (scene.reference_images ?? [])
      .filter((r) => r.startsWith("asset:"))
      .map((r) => r.slice(6).trim())
      .filter((n) => lookFn(n) !== undefined || /^[\w .'-]{1,60}$/.test(n));
    const lock = cast.length
      ? ` CHARACTER LOCK: ${cast.join(" and ")} must match the reference image exactly, as if copying it: same head shape and size, same face, same eyes, same hair, same skin, same build and proportions,${outfit ? "" : " same clothing items in the same colours,"} same hands, and the same rendering style and level of realism as the reference. Never redesign, ${outfit ? "" : "restyle, "}re-proportion, re-age or re-colour them${outfit ? "" : ", and never swap an item for a similar one"}.${cast
          .map((n) => (lookFn(n) ? ` ${n} is exactly: ${lookFn(n)}.` : ""))
          .join("")}${outfit ? ` WARDROBE IN THIS SCENE: ${outfit.trim().replace(/\.$/, "")}. This replaces any clothing in the reference image or the description above, and stays identical for the whole scene.` : ""}`
      : "";
    const noText = scene.type !== "image" && !on_screen_text;
    const textFirst = noText ? "NO SUBTITLES, NO CAPTIONS, NO TEXT OF ANY KIND ON SCREEN. " : "";
    const textLast = noText
      ? " NO TEXT ON SCREEN: never add subtitles, captions, titles, speech transcripts, words or letters anywhere in the picture, at any moment; any speech is heard only, never written."
      : "";
    const inherit = reference_previous
      ? " Match the previous image exactly for the subject's appearance, colour palette, lighting and rendering style; this is the same scene a moment later."
      : "";
    jobs.push(
      queue.add(
        {
          ...scene,
          prompt: `${textFirst}${scene.prompt.trim().replace(/\.?$/, ".")}${phrase ? ` ${phrase}` : ""}${lock}${inherit}${textLast}`,
          chain_from: chain_previous ? jobs[i - 1].id : undefined,
          reference_from: reference_previous ? jobs[i - 1].id : undefined,
          output_dir,
          file_stem: `scene-${String(offset + i + 1).padStart(2, "0")}`,
        },
        { accountId: owner.id, accountLabel: owner.label },
      ),
    );
  }
  return { output_dir, jobs };
}

export function buildAgentJob(
  { project, scenes, aspect_ratio, download_quality, references, scene_references }: Args<"agent">,
  outputRoot: string,
  queue: JobQueue,
  owner: { id: string; label: string },
): { output_dir: string; job: Job } {
  const output_dir = projectDir(project, outputRoot);
  if (scene_references && scene_references.length !== scenes.length) {
    throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, `scene_references has ${scene_references.length} entries for ${scenes.length} scenes; give one list per scene (empty for none).`);
  }
  const known = new Set((references ?? []).map((r) => r.name.toLowerCase()));
  const unknown = [...new Set((scene_references ?? []).flat().filter((n) => !known.has(n.toLowerCase())))];
  if (unknown.length) throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, `scene_references names ${unknown.map((n) => `"${n}"`).join(", ")}, which is not in references.`);
  for (const r of references ?? []) {
    if (!r.image.startsWith("asset:") && !existsSync(r.image)) throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, `Reference image not found: ${r.image}`);
  }
  const job = queue.add(
    {
      agent_refs: references?.length ? references : undefined,
      agent_scene_refs: references?.length ? scene_references : undefined,
      prompt: `Agent batch: ${scenes.length} images`,
      type: "image",
      max_credits: 0,
      aspect_ratio,
      download_quality,
      agent_scenes: scenes,
      output_dir,
      file_stem: nextStem(queue, output_dir, "scene"),
    },
    { accountId: owner.id, accountLabel: owner.label },
  );
  return { output_dir, job };
}

export async function downloadAssetsOp({ project, assets, quality, collection }: Args<"download">, outputRoot: string, deps: CoreMediaDeps) {
  if (!assets.length && !collection) throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, "Name the assets to download, or a collection.");
  const dir = projectDir(project, outputRoot);
  mkdirSync(dir, { recursive: true });
  const files: string[] = collection ? await deps.downloadCollection(collection, dir) : [];
  let next = Math.max(0, ...readdirSync(dir).map((f) => Number(f.match(/^clip-(\d+)/)?.[1] ?? 0))) + 1;
  for (const name of assets) {
    try {
      files.push(...(await deps.downloadAsset(name, join(dir, `clip-${String(next++).padStart(2, "0")}`), quality)));
    } catch (err) {
      throw new Error(`${err instanceof Error ? err.message : err} (downloaded so far: ${files.length})`);
    }
  }
  return { dir, files };
}

export async function assembleFilmOp({ project, voice_lines, ...rest }: Args<"assemble">, outputRoot: string, deps: CoreMediaDeps) {
  const dir = projectDir(project, outputRoot);
  if (!voice_lines?.length) return deps.assemble({ dir, ...rest });
  mkdirSync(dir, { recursive: true });
  const track = await deps.voiceTrack(voice_lines, join(dir, `${rest.output_name.replace(/[^\w.-]+/g, "_")}-voice.wav`));
  const film = await deps.assemble({ dir, ...rest, voiceover: track.file });
  return { ...film, voice: track };
}

export async function findContinueEcho(fromAsset: string, deps: CoreMediaDeps): Promise<void> {
  const recent = (await deps.listAssets()).slice(0, 6).filter((a) => a.kind === "video");
  const source = fromAsset.toLowerCase();
  const echo = recent.find((a) => {
    const n = a.name.toLowerCase();
    return n !== source && !n.startsWith(source) && words(n).some((w) => words(source).includes(w));
  });
  if (echo) {
    throw new Error(
      `Flow already holds a recent clip called "${echo.name}", which looks like a continuation of "${fromAsset}" that may have just been generated and charged for. Check it with flow_assets / flow_download before spending again. Pass force: true if you really do want another take.`,
    );
  }
}

export function discardFileOp(path: string, outputRoot: string, moveFn: typeof moveToBin) {
  const target = resolve(path);
  const rel = relative(outputRoot, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    throw new AppError(403, ERROR_CODES.PATH_OUTSIDE_ALLOWLIST, "Only things inside your films folder can be moved to the bin from here.");
  }
  if (!existsSync(target)) throw new AppError(404, ERROR_CODES.NOT_FOUND, "That file is already gone.");
  return { trashed: target, to: moveFn(target), bin: BIN };
}

export async function createCharacterOp(a: Args<"character">, deps: CoreMediaDeps) {
  if (!a.image && !a.describe) throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, "Pass either `describe` (Flow draws the portrait) or `image`.");
  const made = await deps.createCharacter(a);
  if (a.describe) deps.rememberCharacter(a.name, a.describe);
  else if (a.look) deps.rememberCharacter(a.name, a.look);
  else deps.forgetCharacter(a.name);
  return { ...made, use_as: `asset:${a.name}` };
}

export async function editCharacterOp({ name, change, look }: Args<"character_edit">, deps: CoreMediaDeps) {
  const out = await deps.editCharacter(name, change);
  if (look) deps.rememberCharacter(name, look);
  else if (change) deps.rememberCharacter(name, `${deps.characterLook(name) ?? ""} Changed since, and this wins over anything above: ${change.replace(/[.\s]+$/, "")}`.trim());
  return { ...out, use_as: `asset:${name}` };
}

export async function voicesWithDeps(deps: CoreMediaDeps) {
  const place = { computer: COMPUTER, bin: BIN, platform: process.platform };
  return { kokoro: KOKORO_VOICES, kokoro_ready: deps.kokoroReady(), kokoro_mb: KOKORO_MB, gemini: GEMINI_VOICES, gemini_ready: Boolean(deps.geminiKey()), place };
}

export async function narrateWithDeps({ project, text, voice, engine, speed, style }: Args<"narrate">, deps: CoreMediaDeps) {
  const output_dir = projectDir(project, deps.getConfig().outputRoot);
  mkdirSync(output_dir, { recursive: true });
  const taken = readdirSync(output_dir).map((f) => Number(f.match(/^narration-(\d+)/)?.[1] ?? 0));
  const target = join(output_dir, `narration-${String(Math.max(0, ...taken) + 1).padStart(2, "0")}.m4a`);
  const line = text.trim();
  if (engine === "kokoro") {
    const v = voice ?? KOKORO_DEFAULT_VOICE;
    return { output_dir, credits: 0, engine, voice: v, ...(await deps.speakWithKokoro(line, v, target, speed)) };
  }
  const v = voice ?? "Charon";
  try {
    return { output_dir, credits: 0, engine, voice: v, ...(await deps.speakWithGemini(line, v, target, style)) };
  } catch (err) {
    if (!/\b429\b|quota|RESOURCE_EXHAUSTED|rate limit/i.test(String((err as Error).message))) throw err;
    const spoken = await deps.speakWithKokoro(line, KOKORO_DEFAULT_VOICE, target);
    return {
      output_dir,
      credits: 0,
      engine: "kokoro",
      voice: KOKORO_DEFAULT_VOICE,
      fell_back_from: "gemini",
      ...spoken,
      note: `Google AI Studio's daily limit is used up, so this take was recorded with Kokoro (${KOKORO_DEFAULT_VOICE}) instead. Record it again with ${v} once the limit resets.`,
    };
  }
}

export async function transcribeWithDeps({ video, language, words: includeWords }: Args<"transcribe">, deps: CoreMediaDeps) {
  const res = await deps.transcribe(video, language);
  return {
    text: res.text,
    word_count: res.words.length,
    language: res.language,
    model: res.model,
    ...(includeWords ? { words: res.words.map((w) => ({ text: w.text, start: Number(w.start.toFixed(2)), end: Number(w.end.toFixed(2)) })) } : {}),
  };
}

export async function presenterWithDeps({ project, ...a }: Args<"presenter">, deps: CoreMediaDeps) {
  return deps.presenter({ ...a, dir: projectDir(project, deps.getConfig().outputRoot) });
}

export async function captionPreviewWithDeps(a: Args<"caption_preview">, deps: CoreMediaDeps) {
  return deps.previewCaptions(a.video, a);
}

export async function captionsWithDeps({ project, ...a }: Args<"captions">, deps: CoreMediaDeps) {
  const root = deps.getConfig().outputRoot;
  const rel = relative(root, dirname(a.video));
  const inFilms = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  const dir = project ? projectDir(project, root) : inFilms ? dirname(a.video) : projectDir("Captions", root);
  mkdirSync(dir, { recursive: true });
  return deps.burnCaptions(a.video, a, deps.captionedName(dir, a.video));
}

export async function captionSetupWithDeps(deps: CoreMediaDeps) {
  return deps.captionSetup();
}

export const voicesHere = () => voicesWithDeps(activeMediaDeps);
export const narrateHere = (a: Args<"narrate">) => narrateWithDeps(a, activeMediaDeps);
export const transcribeHere = (a: Args<"transcribe">) => transcribeWithDeps(a, activeMediaDeps);
export const presenterHere = (a: Args<"presenter">) => presenterWithDeps(a, activeMediaDeps);
export const captionPreviewHere = (a: Args<"caption_preview">) => captionPreviewWithDeps(a, activeMediaDeps);
export const captionsHere = (a: Args<"captions">) => captionsWithDeps(a, activeMediaDeps);
export const captionSetupHere = () => captionSetupWithDeps(activeMediaDeps);
