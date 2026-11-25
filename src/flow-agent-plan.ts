import { AppError } from "./errors.js";
import { CreditExhaustedError } from "./flow-credits.js";
import type { SceneParams } from "./queue.js";

export const AGENT_CHUNK = 20;
export const MAX_ONE_BY_ONE = 3;

export interface AgentBatchResumeState {
  done: Set<number>;
  files: string[];
}

export function createAgentBatchResumeState(): AgentBatchResumeState {
  return { done: new Set<number>(), files: [] };
}

const STOP_WORDS = new Set(
  "the and with from into over under that this then than are was for her his its their onto next near across wide shot close scene image".split(" "),
);
const words = (text: string) =>
  new Set(text.toLowerCase().match(/[a-z0-9']{3,}/g)?.filter((w) => !STOP_WORDS.has(w)) ?? []);

export function matchScenes(scenes: string[], prompts: string[]): number[][] {
  const all = scenes.map(words);
  const count = new Map<string, number>();
  for (const ws of all) for (const w of ws) count.set(w, (count.get(w) ?? 0) + 1);
  const common = (w: string) => scenes.length > 2 && (count.get(w) as number) >= Math.max(2, Math.ceil(scenes.length * 0.6));
  const sceneWords = all.map((ws) => {
    const own = new Set([...ws].filter((w) => !common(w)));
    return own.size >= 3 ? own : ws;
  });
  const pairs: { scene: number; tile: number; score: number }[] = [];
  prompts.forEach((prompt, tile) => {
    const have = words(prompt);
    sceneWords.forEach((want, scene) => {
      const hit = [...want].filter((w) => have.has(w)).length;
      pairs.push({ scene, tile, score: want.size ? hit / want.size : 0 });
    });
  });
  pairs.sort((x, y) => y.score - x.score);
  const out: number[][] = scenes.map(() => []);
  const usedTiles = new Set<number>();
  for (const firstPass of [true, false]) {
    for (const { scene, tile, score } of pairs) {
      if (score < 0.3 || usedTiles.has(tile) || (firstPass && out[scene].length)) continue;
      out[scene].push(tile);
      usedTiles.add(tile);
    }
  }
  return out;
}

export function sceneNumberOf(params: Pick<SceneParams, "file_stem" | "agent_numbers">, index: number): number {
  const base = Number(params.file_stem.match(/\d+/)?.[0] ?? 1);
  return params.agent_numbers?.[index] ?? base + index;
}

export function remainingSceneIndexes(total: number, done: ReadonlySet<number>): number[] {
  const todo: number[] = [];
  for (let i = 0; i < total; i++) {
    if (!done.has(i)) todo.push(i);
  }
  return todo;
}

export function remainingSceneNumbers(
  params: Pick<SceneParams, "file_stem" | "agent_numbers" | "agent_scenes">,
  done: ReadonlySet<number>,
): number[] {
  const total = params.agent_scenes?.length ?? 0;
  return remainingSceneIndexes(total, done).map((i) => sceneNumberOf(params, i));
}

export function chunkIndexes(indexes: number[], chunkSize = AGENT_CHUNK): number[][] {
  const chunks: number[][] = [];
  for (let c = 0; c < indexes.length; c += chunkSize) {
    chunks.push(indexes.slice(c, c + chunkSize));
  }
  return chunks;
}

export function buildAgentScript(params: SceneParams, indexes: number[], retry: boolean): string {
  const scenes = params.agent_scenes!;
  const aspect = params.aspect_ratio ?? "16:9";
  const refs = params.agent_refs ?? [];
  const assets = params.agent_ref_assets ?? [];
  const script = indexes
    .map((i) => {
      const uses = params.agent_scene_refs?.[i];
      const tag = !refs.length || !uses ? "" : uses.length ? ` (use references: ${uses.join(", ")})` : " (no reference)";
      return `Scene ${sceneNumberOf(params, i)}${tag}: ${scenes[i].replace(/\s*\n+\s*/g, " ").trim()}`;
    })
    .join(" ");
  const legend = refs.length
    ? ` The ${refs.length} attached image(s) are references: ${refs.map((r, k) => `${assets[k] ?? `image ${k + 1}`} is ${r.name}`).join("; ")}. ` +
      `Whenever a scene shows one of them, keep it exactly as it looks in its reference (face, hair, clothing, shape, colours), ` +
      `but stage each scene as its own description says; the references are for likeness only, never copy their pose or background.`
    : "";
  const lead = retry
    ? `${indexes.length} image(s) from the last batch failed to generate. Generate them again now, one image per scene`
    : `Generate exactly ${indexes.length} separate images, one image per scene, in scene order`;
  return `${lead}. Images only, never video. ${aspect} aspect ratio. Do not ask questions, generate them now.${legend} ${script}`;
}

export function buildAgentFallbackRefs(params: SceneParams, index: number): string[] | undefined {
  const refs = params.agent_refs ?? [];
  if (!refs.length) return undefined;
  const uses = params.agent_scene_refs?.[index];
  const picked = refs
    .map((r, k) => ({ r, k }))
    .filter(({ r }) => !uses || uses.some((u) => u.toLowerCase() === r.name.toLowerCase()))
    .slice(0, 3);
  return picked.length
    ? picked.map(({ r, k }) => (params.agent_ref_assets?.[k] ? `asset:${params.agent_ref_assets[k]}` : r.image))
    : undefined;
}

export function computeOneByOnePartition(
  missing: number[],
  numberOf: (i: number) => number,
  maxOneByOne = MAX_ONE_BY_ONE,
): { runIndexes: number[]; skippedNumbers: number[] } {
  if (missing.length > maxOneByOne) {
    return { runIndexes: [], skippedNumbers: missing.map(numberOf) };
  }
  return { runIndexes: missing, skippedNumbers: [] };
}

export function formatAgentSummaryNote(opts: {
  failed: number[];
  agentProblem: string;
  agentTimedOut: boolean;
  doneCount: number;
  totalScenes: number;
  refCount: number;
  agentRetries: number;
  failedTiles: number;
  oneByOneRecovered: number;
}): string {
  return [
    opts.failed.length ? `still failed: scene ${opts.failed.join(", ")} (use Retry)` : "",
    opts.agentProblem ? `agent mode failed (${opts.agentProblem}), so the images were made one by one` : "",
    opts.agentTimedOut ? "the agent stalled and was stopped" : "",
    `${opts.doneCount} of ${opts.totalScenes} scenes came from the agent`,
    opts.refCount ? `${opts.refCount} reference image(s) attached` : "",
    opts.agentRetries ? `${opts.agentRetries} asked again` : "",
    opts.failedTiles ? `${opts.failedTiles} tile(s) failed in Flow` : "",
    opts.oneByOneRecovered > 0 ? `${opts.oneByOneRecovered} re-run one by one` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function shouldRethrowAgentError(err: unknown): boolean {
  return err instanceof CreditExhaustedError || err instanceof AppError;
}

export function addCreditDelta(
  currentCredits: number | undefined,
  before: number | undefined,
  after: number | undefined,
): number | undefined {
  if (before === undefined || after === undefined) return currentCredits;
  const delta = Math.max(0, before - after);
  return (currentCredits ?? 0) + delta;
}
