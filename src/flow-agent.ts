import {
  closeAgentSession,
  CollectionError,
  collectionFor,
  ensureProjectGrid,
  pause,
  readCredits,
  requireFlowProject,
  runGeneration,
  setAgentMode,
  setAgentSettings,
  step,
  uploadAsset,
} from "./flow.js";
import {
  AGENT_CHUNK,
  addCreditDelta,
  buildAgentFallbackRefs,
  chunkIndexes,
  computeOneByOnePartition,
  createAgentBatchResumeState,
  formatAgentSummaryNote,
  remainingSceneIndexes,
  sceneNumberOf,
  shouldRethrowAgentError,
  type AgentBatchResumeState,
} from "./flow-agent-plan.js";
import { agentRound } from "./flow-agent-round.js";
import type { Job } from "./queue.js";

export async function runAgentBatch(job: Job, resume?: AgentBatchResumeState): Promise<string[]> {
  const page = await requireFlowProject();
  const s = job.params;
  const scenes = s.agent_scenes!;

  await ensureProjectGrid(page);
  const balance = await readCredits(page).catch(() => undefined);

  const state = resume ?? createAgentBatchResumeState();
  const { files, done } = state;
  const numberOf = (i: number) => sceneNumberOf(s, i);
  let agentTimedOut = false;
  let failedTiles = 0;
  let agentRetries = 0;
  let agentProblem = "";
  let collectionProblem = "";
  let fatalErr: unknown = null;

  try {
    if (s.agent_refs?.length && !s.agent_ref_assets?.length) {
      await setAgentMode(page, false);
      const assets: string[] = [];
      for (const [k, r] of s.agent_refs.entries()) {
        step(job, `uploading reference ${k + 1} of ${s.agent_refs.length} (${r.name})`);
        const label = r.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || `ref${k + 1}`;
        assets.push(await uploadAsset(page, job, r.image, label));
      }
      s.agent_ref_assets = assets;
    }

    step(job, "switching Agent mode on");
    await setAgentMode(page, true);
    step(job, "setting the agent to generate without asking");
    await setAgentSettings(page, "Never", s.aspect_ratio ?? "16:9");

    rounds: for (let round = 0; round < 3; round++) {
      const todo = remainingSceneIndexes(scenes.length, done);
      if (!todo.length) break;
      if (round) {
        agentRetries += todo.length;
        job.progress = `asking the agent again for ${todo.length} scene(s)`;
      }
      for (const chunk of chunkIndexes(todo, AGENT_CHUNK)) {
        if (todo.length > AGENT_CHUNK) {
          step(job, `asking the agent for scenes ${numberOf(chunk[0])}-${numberOf(chunk[chunk.length - 1])}`);
        }
        const out = await agentRound(page, job, scenes, chunk, round > 0, files, done);
        agentTimedOut ||= out.timedOut;
        failedTiles = out.failedTiles;
        if (!out.produced) {
          if (!done.size) agentProblem = `it drew nothing${out.reply ? `; it said: "${out.reply}"` : ""}.`;
          break rounds;
        }
      }
    }
  } catch (err) {
    if (shouldRethrowAgentError(err)) {
      fatalErr = err;
    } else if (err instanceof CollectionError) {
      collectionProblem = err.message;
    } else {
      agentProblem = (err as Error).message;
    }
  } finally {
    step(job, "putting the agent settings back");
    await ensureProjectGrid(page).catch(() => {});
    await closeAgentSession(page).catch(() => {});
    await setAgentMode(page, true).catch(() => {});
    await setAgentSettings(page, "Always").catch(() => {});
    await setAgentMode(page, false).catch(() => {});
    if (fatalErr) {
      const leftOnAbort = await readCredits(page).catch(() => undefined);
      job.credits = addCreditDelta(job.credits, balance, leftOnAbort);
    }
  }

  if (fatalErr) throw fatalErr;

  if (agentProblem && !done.size) {
    throw new Error(`Flow's agent could not run this batch: ${agentProblem} Nothing was made one by one instead.`);
  }
  if (collectionProblem) {
    throw new Error(
      `${collectionProblem} The images are in Flow (collection "${collectionFor(job)}" if they were moved there): ` +
        `flow_download with collection "${collectionFor(job)}" fetches them as one ZIP without generating anything. ` +
        (files.length ? `Saved before it stopped: ${files.length} file(s) in ${s.output_dir}.` : "Nothing was saved yet."),
    );
  }

  const missing = remainingSceneIndexes(scenes.length, done);
  const { runIndexes, skippedNumbers } = computeOneByOnePartition(missing, numberOf);
  const failed: number[] = [...skippedNumbers];
  const stillFails = Number(process.env.FLOW_MCP_SIMULATE_FAILED ?? 0);
  let oneByOneAttempted = 0;
  let oneByOneRecovered = 0;

  for (const [n, i] of runIndexes.entries()) {
    oneByOneAttempted++;
    job.progress = `re-running scene ${numberOf(i)} one by one (${n + 1}/${runIndexes.length})`;
    if (numberOf(i) === stillFails && !job.params.agent_numbers) {
      failed.push(numberOf(i));
      continue;
    }
    const single: Job = {
      ...job,
      files: [],
      params: {
        prompt: scenes[i],
        type: "image",
        max_credits: 0,
        reference_images: buildAgentFallbackRefs(s, i),
        aspect_ratio: s.aspect_ratio,
        download_quality: s.download_quality,
        output_dir: s.output_dir,
        file_stem: `scene-${String(numberOf(i)).padStart(2, "0")}`,
      },
    };
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      if (attempt || n) await pause(page, 8000);
      try {
        files.push(...(await runGeneration(single)));
        done.add(i);
        oneByOneRecovered++;
        ok = true;
      } catch (err) {
        if (shouldRethrowAgentError(err)) {
          const leftOnSingle = await readCredits(page).catch(() => undefined);
          job.credits = addCreditDelta(job.credits, balance, leftOnSingle);
          throw err;
        }
      }
    }
    if (!ok) failed.push(numberOf(i));
  }

  job.failed_scenes = failed.length ? failed : undefined;
  step(job, "reading the credit balance");
  const left = await readCredits(page).catch(() => undefined);
  step(job, undefined);
  files.sort();
  job.note = formatAgentSummaryNote({
    failed,
    agentProblem,
    agentTimedOut,
    doneCount: done.size,
    totalScenes: scenes.length,
    refCount: s.agent_refs?.length ?? 0,
    agentRetries,
    failedTiles,
    oneByOneRecovered: oneByOneAttempted > 0 ? oneByOneRecovered : 0,
  });
  if (!files.length) throw new Error("No image could be generated for any scene. Open the Flow tab to see what Flow reported.");

  job.credits = addCreditDelta(job.credits, balance, left);
  return files;
}
