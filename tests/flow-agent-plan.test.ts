import assert from "node:assert/strict";
import test from "node:test";
import { AppError, ERROR_CODES } from "../dist/errors.js";
import {
  addCreditDelta,
  AGENT_CHUNK,
  buildAgentFallbackRefs,
  buildAgentScript,
  chunkIndexes,
  computeOneByOnePartition,
  createAgentBatchResumeState,
  formatAgentSummaryNote,
  MAX_ONE_BY_ONE,
  matchScenes,
  remainingSceneIndexes,
  remainingSceneNumbers,
  sceneNumberOf,
  shouldRethrowAgentError,
} from "../dist/flow-agent-plan.js";
import { CreditExhaustedError } from "../dist/flow-credits.js";
import type { SceneParams } from "../dist/queue.js";

test("flow-agent-plan handles chunk planning, scene matching, resume tracking, fallback refs, and credit deltas", () => {
  assert.equal(AGENT_CHUNK, 20);
  assert.equal(MAX_ONE_BY_ONE, 3);

  const resume = createAgentBatchResumeState();
  assert.equal(resume.done.size, 0);
  assert.deepEqual(resume.files, []);

  // matchScenes handles shared boilerplate, extra takes, and low-score filtering
  const scenes = [
    "Wide cinematic shot of an astronaut walking across red Martian dunes at sunset",
    "Wide cinematic shot of a submarine gliding past bioluminescent coral reefs",
    "Wide cinematic shot of a chef tossing ramen noodles inside a steamy neon kitchen",
  ];
  const prompts = [
    "Astronaut boots kicking dust on red Martian dunes under sunset light",
    "Chef tossing steaming ramen noodles in bright neon kitchen",
    "Unrelated abstract purple triangle pattern",
    "Another view of astronaut helmet on Martian dunes",
  ];
  const matched = matchScenes(scenes, prompts);
  assert.deepEqual(matched[0], [0, 3]);
  assert.deepEqual(matched[1], []);
  assert.deepEqual(matched[2], [1]);

  // Small batch (< 3 scenes), sparse unique words fallback (< 3 own words), and empty prompt edge
  assert.deepEqual(matchScenes(["Hero standing", ""], ["Hero standing tall"]), [[0], []]);
  assert.deepEqual(matchScenes(["alpha beta", "alpha beta gamma", "alpha beta delta"], ["alpha beta", "gamma", "delta"]), [[0], [1], [2]]);

  // Numbering & chunking across mid-batch resume
  const baseParams: SceneParams = {
    prompt: "Agent batch",
    type: "image",
    max_credits: 0,
    aspect_ratio: "16:9",
    output_dir: "/tmp/out",
    file_stem: "scene-05",
    agent_scenes: ["First prompt\non two lines", "Second prompt", "Third prompt"],
  };
  assert.equal(sceneNumberOf(baseParams, 0), 5);
  assert.equal(sceneNumberOf({ file_stem: "custom", agent_numbers: [10, 20] }, 1), 20);
  assert.equal(sceneNumberOf({ file_stem: "custom" }, 2), 3);

  const done = new Set([0]);
  assert.deepEqual(remainingSceneIndexes(3, done), [1, 2]);
  assert.deepEqual(remainingSceneNumbers(baseParams, done), [6, 7]);
  assert.deepEqual(remainingSceneNumbers({ file_stem: "s" }, done), []);
  assert.deepEqual(chunkIndexes([0, 1]), [[0, 1]]);
  assert.deepEqual(chunkIndexes([0, 1, 2, 3, 4], 2), [[0, 1], [2, 3], [4]]);

  // Script building with and without references, initial vs retry
  const scriptNoRef = buildAgentScript(baseParams, [0, 1], false);
  assert.match(scriptNoRef, /^Generate exactly 2 separate images/);
  assert.match(scriptNoRef, /Scene 5: First prompt on two lines Scene 6: Second prompt/);

  const refParams: SceneParams = {
    ...baseParams,
    aspect_ratio: undefined,
    agent_refs: [
      { image: "/tmp/hero.png", name: "Hero" },
      { image: "/tmp/villa.png", name: "Villa" },
    ],
    agent_ref_assets: ["fm-1-hero.png"],
    agent_scene_refs: [["Hero"], []],
  };
  const scriptRetryRef = buildAgentScript(refParams, [0, 1, 2], true);
  assert.match(scriptRetryRef, /^3 image\(s\) from the last batch failed/);
  assert.match(scriptRetryRef, /16:9 aspect ratio/);
  assert.match(scriptRetryRef, /fm-1-hero\.png is Hero; image 2 is Villa/);
  assert.match(scriptRetryRef, /Scene 5 \(use references: Hero\)/);
  assert.match(scriptRetryRef, /Scene 6 \(no reference\)/);
  assert.match(scriptRetryRef, /Scene 7:/);

  // Fallback refs (with uploaded asset, without uploaded asset, empty scene uses, no refs)
  assert.equal(buildAgentFallbackRefs(baseParams, 0), undefined);
  assert.deepEqual(buildAgentFallbackRefs(refParams, 0), ["asset:fm-1-hero.png"]);
  assert.equal(buildAgentFallbackRefs(refParams, 1), undefined);
  assert.deepEqual(buildAgentFallbackRefs(refParams, 2), ["asset:fm-1-hero.png", "/tmp/villa.png"]);

  // One-by-one partition
  assert.deepEqual(computeOneByOnePartition([0, 1], (i) => i + 1, 3), { runIndexes: [0, 1], skippedNumbers: [] });
  assert.deepEqual(computeOneByOnePartition([0, 1, 2, 3], (i) => i + 1, 3), {
    runIndexes: [],
    skippedNumbers: [1, 2, 3, 4],
  });

  // Summary note formatting (both rich and minimal)
  const fullNote = formatAgentSummaryNote({
    failed: [7],
    agentProblem: "stalled",
    agentTimedOut: true,
    doneCount: 2,
    totalScenes: 3,
    refCount: 2,
    agentRetries: 1,
    failedTiles: 1,
    oneByOneRecovered: 1,
  });
  assert.match(fullNote, /still failed: scene 7/);
  assert.match(fullNote, /agent mode failed \(stalled\)/);
  assert.match(fullNote, /stalled and was stopped/);
  assert.match(fullNote, /2 of 3 scenes/);
  assert.match(fullNote, /2 reference image/);
  assert.match(fullNote, /1 asked again/);
  assert.match(fullNote, /1 tile\(s\) failed/);
  assert.match(fullNote, /1 re-run one by one/);

  assert.equal(
    formatAgentSummaryNote({
      failed: [],
      agentProblem: "",
      agentTimedOut: false,
      doneCount: 5,
      totalScenes: 5,
      refCount: 0,
      agentRetries: 0,
      failedTiles: 0,
      oneByOneRecovered: 0,
    }),
    "5 of 5 scenes came from the agent",
  );

  // Fatal error rethrow classification
  assert.equal(shouldRethrowAgentError(new CreditExhaustedError({ reason: "low" })), true);
  assert.equal(shouldRethrowAgentError(new AppError(503, ERROR_CODES.AUTH_REQUIRED, "auth")), true);
  assert.equal(shouldRethrowAgentError(new Error("transient tile error")), false);

  // Credit delta accumulation across failover attempts
  assert.equal(addCreditDelta(undefined, undefined, 90), undefined);
  assert.equal(addCreditDelta(undefined, 100, undefined), undefined);
  assert.equal(addCreditDelta(undefined, 100, 85), 15);
  assert.equal(addCreditDelta(15, 500, 495), 20);
  assert.equal(addCreditDelta(20, 10, 20), 20);
});
