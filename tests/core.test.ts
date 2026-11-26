import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getActiveAccountPaths, resolveAccountPaths } from "../dist/account-paths.js";
import { AccountStore } from "../dist/accounts.js";
import { ChromeManager, getDefaultChromeManager, setDefaultChromeManager } from "../dist/chrome.js";
import { getConfig } from "../dist/config.js";
import {
  LocalCore,
  VOICES,
  captionPreviewHere,
  captionSetupHere,
  captionsHere,
  narrateHere,
  presenterHere,
  transcribeHere,
  voicesHere,
} from "../dist/core.js";
import { runQueuedJob, setCoreMediaDeps, type CoreMediaDeps } from "../dist/core-media.js";
import { AppError, ERROR_CODES } from "../dist/errors.js";
import { getFlowState, requireFlowProject, type FlowState } from "../dist/flow.js";
import { JobQueue } from "../dist/queue.js";

function stubChrome(cfgFn: () => ReturnType<typeof getConfig>, failClose = false) {
  let cdpUp = false;
  let curProfile = "";
  let curUrl = "https://flow.google.com/project/11111111-1111-1111-1111-111111111111";
  const page = {
    url: () => curUrl,
    goto: async (u: string) => {
      curUrl = u;
    },
    bringToFront: async () => undefined,
    evaluate: async () => "en",
    waitForFunction: async () => undefined,
  } as never;
  const browser = {
    isConnected: () => cdpUp,
    contexts: () => [{ pages: () => [page], newPage: async () => page }],
    newBrowserCDPSession: async () => ({ send: async () => undefined }),
    close: async () => {
      if (failClose) throw new Error("close fail");
      cdpUp = false;
    },
    on: () => undefined,
  } as never;
  return new ChromeManager({
    getConfig: cfgFn,
    cdpProbe: async () => ({ ok: cdpUp, isCdp: cdpUp }),
    connectOverCDP: async () => browser,
    spawnChrome: (_b, args) => {
      curProfile = args.find((a) => a.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
      cdpUp = true;
      return 888;
    },
    listProcesses: async () => (cdpUp ? [{ pid: 888, command: `chrome --user-data-dir=${curProfile} --remote-debugging-port=${cfgFn().cdpPort}` }] : []),
    isPidAlive: () => cdpUp,
    killPid: () => {
      cdpUp = false;
    },
    executable: () => "/usr/bin/chrome",
    sleep: async () => undefined,
    launchTimeoutMs: 50,
    closeTimeoutMs: 20,
    termTimeoutMs: 20,
  });
}

test("LocalCore default constructor wiring, cast/characters/outputs/new_project, retry guard, and wrapChromeOp", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-core-"));
  const prevHome = process.env.FLOW_MCP_HOME;
  const prevOut = process.env.FLOW_MCP_OUTPUT;
  const prevMin = process.env.FLOW_MCP_PAUSE_MIN_S;
  const prevMax = process.env.FLOW_MCP_PAUSE_MAX_S;
  process.env.FLOW_MCP_HOME = join(root, "def-home");
  process.env.FLOW_MCP_OUTPUT = join(root, "def-out");
  process.env.FLOW_MCP_PAUSE_MIN_S = "0.001";
  process.env.FLOW_MCP_PAUSE_MAX_S = "0.001";

  try {
    // 0-arg LocalCore() constructor exercises all default deps fallbacks
    assert.ok(VOICES.length > 0);
    const bareCore = new LocalCore();
    assert.equal(getDefaultChromeManager(), bareCore.chrome);
    assert.equal(getActiveAccountPaths().castDir, join(root, "def-out", "_cast"));
    await bareCore.close();

    // LocalCore with failing chrome.closeChrome swallows close error cleanly
    const failCloseCfg = getConfig({ FLOW_MCP_HOME: join(root, "fc-home"), FLOW_MCP_OUTPUT: join(root, "fc-out"), FLOW_MCP_CDP_PORT: "9460" });
    const failCm = new ChromeManager({
      getConfig: () => failCloseCfg,
      cdpProbe: async () => {
        throw new Error("probe fail");
      },
    });
    const failCore = new LocalCore({ getConfig: () => failCloseCfg, chrome: failCm });
    await failCore.close();

    // Full LocalCore orchestration harness
    const cfg = getConfig({
      FLOW_MCP_HOME: join(root, "home"),
      FLOW_MCP_OUTPUT: join(root, "out"),
      FLOW_MCP_CDP_PORT: "9461",
      FLOW_MCP_PAUSE_MIN_S: "0.001",
      FLOW_MCP_PAUSE_MAX_S: "0.001",
    });
    mkdirSync(join(cfg.homeDir, "chrome-profile"), { recursive: true });
    mkdirSync(join(cfg.outputRoot, "_cast"), { recursive: true });
    writeFileSync(join(cfg.outputRoot, "_cast", "Maya.png"), "png");
    mkdirSync(join(cfg.outputRoot, "MyFilm"), { recursive: true });
    writeFileSync(join(cfg.outputRoot, "MyFilm", "scene-01.mp4"), "vid");

    const store = new AccountStore(cfg);
    const chrome = stubChrome(() => cfg);
    const looks = new Map<string, string>([["Maya", "tall jacket"]]);
    const calls: string[] = [];
    let jobBehavior: "ok" | "fail" | "nofile" | "hold" = "ok";
    let releaseHold!: () => void;

    const mediaStub: Partial<CoreMediaDeps> = {
      characterLook: (n) => looks.get(n),
      rememberCharacter: (n, l) => {
        looks.set(n, l);
      },
      forgetCharacter: (n) => {
        looks.delete(n);
      },
      createCharacter: async (a) => ({ name: a.name, url: "https://flow.google.com/c/1", portrait: "p.png" }),
      editCharacter: async (name) => ({ name, portrait: "p2.png" }),
      listAssets: async () => [
        { name: "Hero Shot", kind: "video" },
        { name: "Hero Shot Two", kind: "video" },
        { name: "Sequel of Hero Shot", kind: "video" },
        { name: "Still One", kind: "image" },
      ],
      downloadCollection: async (_c, dir) => [join(dir, "col-1.mp4")],
      downloadAsset: async (name, stem) => {
        if (name === "throw-err") throw new Error("dl error");
        if (name === "throw-str") throw "dl str";
        return [`${stem}.mp4`];
      },
      trashAsset: async (name) => ({ trashed: name }),
      extractFirstFrame: async (v) => `${v}-first.jpg`,
      extractFrameAt: async (v, s) => `${v}-${s}.jpg`,
      extractLastFrame: async (v) => `${v}-last.jpg`,
      runGeneration: async (j) => {
        calls.push(`gen:${j.params.file_stem}`);
        if (jobBehavior === "hold") await new Promise<void>((r) => (releaseHold = r));
        if (jobBehavior === "fail") throw new Error("gen boom");
        if (jobBehavior === "nofile") return [];
        return [join(j.params.output_dir, `${j.params.file_stem}.${j.params.type === "image" ? "png" : "mp4"}`)];
      },
      runContinue: async (j) => {
        calls.push(`cont:${j.params.continue_from}`);
        return [join(j.params.output_dir, `${j.params.file_stem}.mp4`)];
      },
      runAgentBatch: async (j) => {
        calls.push(`agent:${j.params.agent_scenes?.length}`);
        return [join(j.params.output_dir, `${j.params.file_stem}.png`)];
      },
      runEdit: async (j) => {
        calls.push(`edit:${j.params.edit_asset}`);
        return [join(j.params.output_dir, `${j.params.file_stem}.mp4`)];
      },
      assemble: async (o) => ({ output: join(o.dir, `${o.output_name}.mp4`), clips: o.clips, duration: 5, held_last_frame: 0 }),
      voiceTrack: async (lines, out) => ({ file: out, lines: lines.map(() => ({ at: 0, seconds: 1, speed: 1 })), warnings: [] }),
      saveGeminiKey: async (key) => ({ saved: true, ending: key.slice(-4) }),
      geminiKey: () => "g-key",
      kokoroReady: () => true,
      speakWithKokoro: async (_t, _v, target) => ({ output: target, duration: 2 }),
      speakWithGemini: async (_t, voice, target) => {
        if (voice === "QuotaErr") throw new Error("429 RESOURCE_EXHAUSTED");
        if (voice === "FatalErr") throw new Error("invalid key");
        return { output: target, duration: 2 };
      },
      transcribe: async () => ({ text: "hi", words: [{ text: "hi", start: 0.1, end: 0.5 }], language: "en", model: "base" }),
      presenter: async (o) => ({ output: join(o.dir, "pres.mp4"), duration: 4, segments: 1 }),
      previewCaptions: async () => ({ image: "prev.png", at: 1 }),
      captionedName: (dir, v) => join(dir, `cap-${v.split("/").pop()}`),
      burnCaptions: async (_v, _o, out) => ({ output: out, duration: 4, words: 1, style: "bold", lines: 1 }),
      captionSetup: async () => ({ ready: true, whisper: true, model: true, ffmpeg: true, models_dir: root, note: "ok" }),
      moveToBin: (target) => join(root, "bin", target.split("/").pop()!),
    };

    const flowDriver = {
      getFlowState: async (): Promise<FlowState> => ({
        url: "https://flow.google.com/project/22222222-2222-2222-2222-222222222222",
        connected: true,
        signedIn: true,
        inProject: true,
        authInProgress: false,
        plan: "Pro",
        credits_remaining: 750,
      }),
      createProject: async (title?: string) => ({
        id: "33333333-3333-3333-3333-333333333333",
        url: "https://flow.google.com/project/33333333-3333-3333-3333-333333333333",
        title: title ?? "Untitled",
      }),
      listCharacters: async () => ["Maya", "Ghost"],
    };

    const core = new LocalCore({
      getConfig: () => cfg,
      chrome,
      store,
      flow: flowDriver,
      media: mediaStub,
      waitPollMs: 5,
    });

    // Registry error + account delegations
    assert.equal(core.getRegistryError(), null);
    assert.equal(core.getActiveCastDir(), join(cfg.outputRoot, "_cast"));
    assert.equal((await core.status({ detailed: false })).activeAccountId, "default");
    const added = (await core.account_add({ label: "Backup" })) as { account: { id: string } };
    await core.account_rename({ id: added.account.id, label: "Backup 2" });
    await core.account_enable({ id: added.account.id, enabled: false });
    await core.account_enable({ id: added.account.id, enabled: true });
    await core.account_reorder({ ids: [added.account.id, "default"] });
    await core.account_login({});
    await core.account_refresh({});
    assert.equal((await core.accounts()).accounts.length, 2);

    // cast & characters + outputs on default account (includes _cast)
    const defaultCast = (await core.cast()) as { accountId: string; characters: { name: string; portrait?: string }[] };
    assert.equal(defaultCast.accountId, "default");
    assert.equal(defaultCast.characters[0].portrait, join(cfg.outputRoot, "_cast", "Maya.png"));
    assert.equal((await core.characters()).length, 2);
    assert.equal((await core.outputs()).projects.length, 2);

    // Switch to secondary updates active account paths resolver, castDir, and outputs hides _cast
    await core.account_switch({ id: added.account.id });
    assert.equal(core.getActiveCastDir(), resolveAccountPaths(store.requireActiveAccount(), cfg).castDir);
    assert.equal((await core.outputs()).projects.length, 1);

    // new_project updates active account metadata
    const projOut = (await core.new_project({ title: "Sec Film" })) as { title: string; note: string };
    assert.equal(projOut.title, "Sec Film");
    assert.ok(projOut.note.includes("empty project"));

    // generate validation errors + success with character lock, outfit, technique, on_screen_text, chain_previous, reference_previous, video frames
    await assert.rejects(
      () => core.generate({ project: "MyFilm", scenes: [{ prompt: "a", type: "video", max_credits: 5, chain_previous: true }] }),
      /chain_previous/,
    );
    await assert.rejects(
      () => core.generate({ project: "MyFilm", scenes: [{ prompt: "a", type: "image", max_credits: 5, reference_previous: true }] }),
      /no previous scene/,
    );
    await assert.rejects(
      () => core.generate({ project: "MyFilm", scenes: [{ prompt: "a", type: "image", max_credits: 5, technique: "bad-tech" }] }),
      /Unknown technique/,
    );

    const filmDir = join(cfg.outputRoot, "MyFilm");
    writeFileSync(join(filmDir, "notes.txt"), "ignore");
    writeFileSync(join(filmDir, "clip.mp4"), "vid");
    // Unrelated queued job in another project + stem without digits to exercise offset filter branches
    await core.edit({ project: "OtherProj", asset: "A1", prompt: "fix" });

    const genRes = (await core.generate({
      project: "MyFilm",
      scenes: [
        {
          prompt: "Opening still",
          type: "image",
          max_credits: 5,
          technique: "orbit-360",
          reference_images: ["asset:Maya", "asset:UnknownHero", "asset:bad!name", "/tmp/local.png"],
          outfit: "red coat.",
        },
        {
          prompt: "Follow-up still",
          type: "image",
          max_credits: 5,
          reference_previous: true,
          reference_images: ["asset:Maya"],
        },
        {
          prompt: "Follow-up still two",
          type: "image",
          max_credits: 5,
          reference_previous: true,
        },
        {
          prompt: "Motion shot",
          type: "video",
          max_credits: 10,
          first_frame: join(filmDir, "clip.mp4"),
          first_frame_at: 2,
          last_frame: join(filmDir, "clip.mp4"),
          on_screen_text: true,
        },
        {
          prompt: "Chained shot",
          type: "video",
          max_credits: 10,
          chain_previous: true,
        },
      ],
    })) as { jobs: { id: string; accountId: string; accountLabel: string }[] };
    assert.equal(genRes.jobs.length, 5);
    assert.equal(genRes.jobs[0].accountId, added.account.id);
    assert.equal(genRes.jobs[0].accountLabel, "Backup 2");

    // wait() polls while running, then finishes
    const waited = (await core.wait({ job_ids: [...genRes.jobs.map((j) => j.id), "nonexistent"], timeout_seconds: 5 })) as { finished: boolean };
    assert.equal(waited.finished, true);
    assert.ok(calls.some((c) => c.startsWith("gen:")));
    assert.equal(store.requireActiveAccount().creditsRemaining, 750);

    // generate fresh project without existing output_dir + first_frame without first_frame_at + on_screen_text omitted
    const genFresh = await core.generate({
      project: "BrandNewProj",
      scenes: [{ prompt: "Solo shot", type: "video", max_credits: 5, first_frame: join(filmDir, "clip.mp4") }],
    });
    assert.equal(genFresh.jobs.length, 1);
    await core.wait({ timeout_seconds: 5 });

    // wait() timeout path (job still running when deadline expires)
    jobBehavior = "hold";
    const holdRes = await core.generate({ project: "MyFilm", scenes: [{ prompt: "hold", type: "image", max_credits: 0 }] });
    const timedOut = (await core.wait({ job_ids: [holdRes.jobs[0].id], timeout_seconds: 0.01 })) as { finished: boolean };
    assert.equal(timedOut.finished, false);
    // Cancel missing vs queued; retry cross-account mismatch & own failed job
    await assert.rejects(() => core.cancel({ job_id: "missing-job" }), (e: AppError) => e.code === ERROR_CODES.JOB_NOT_FOUND);
    const queuedForCancel = await core.generate({ project: "MyFilm", scenes: [{ prompt: "q", type: "image", max_credits: 0 }] });
    const cancelled = await core.cancel({ job_id: queuedForCancel.jobs[0].id });
    assert.equal(cancelled.status, "cancelled");
    releaseHold();
    await core.wait({ timeout_seconds: 5 });

    // Trigger failed portable job and failed bound job on secondary, switch to default, verify bound retry throws ACCOUNT_MISMATCH while portable retry succeeds
    jobBehavior = "fail";
    const failedBound = await core.generate({ project: "MyFilm", scenes: [{ prompt: "bound fail", type: "image", max_credits: 0, first_frame: "asset:Hero" }] });
    const failedPortable = await core.generate({ project: "MyFilm", scenes: [{ prompt: "will fail", type: "image", max_credits: 0 }] });
    await core.wait({ timeout_seconds: 5 });
    await core.account_switch({ id: "default" });
    await assert.rejects(() => core.retry({ job_ids: [failedBound.jobs[0].id] }), (e: AppError) => e.code === ERROR_CODES.ACCOUNT_MISMATCH);
    jobBehavior = "ok";
    const retriedPortable = await core.retry({ job_ids: [failedPortable.jobs[0].id] });
    assert.equal(retriedPortable.jobs[0].accountId, "default");
    await core.wait({ timeout_seconds: 5 });
    await core.account_switch({ id: added.account.id });
    cfg.pauseMinMs = 200;
    cfg.pauseMaxMs = 200;
    const retriedOwn = await core.retry({ job_ids: [failedBound.jobs[0].id] });
    assert.equal(retriedOwn.jobs.length, 1);
    cfg.pauseMinMs = 1;
    cfg.pauseMaxMs = 1;
    await core.wait({ timeout_seconds: 5 });

    // runner failure branches: reference_previous & chain_previous with no files produced
    jobBehavior = "nofile";
    const noRef = await core.generate({
      project: "MyFilm",
      scenes: [
        { prompt: "empty1", type: "image", max_credits: 0 },
        { prompt: "empty2", type: "image", max_credits: 0, reference_previous: true },
      ],
    });
    await core.wait({ job_ids: noRef.jobs.map((j) => j.id), timeout_seconds: 5 });
    assert.match(core["queue"].get(noRef.jobs[1].id)?.error ?? "", /reference_previous/);

    const noChain = await core.generate({
      project: "MyFilm",
      scenes: [
        { prompt: "emptyv1", type: "video", max_credits: 0 },
        { prompt: "emptyv2", type: "video", max_credits: 0, chain_previous: true },
      ],
    });
    await core.wait({ job_ids: noChain.jobs.map((j) => j.id), timeout_seconds: 5 });
    assert.match(core["queue"].get(noChain.jobs[1].id)?.error ?? "", /chain_previous/);
    jobBehavior = "ok";

    // agent, edit, continue_shot (echo + non-echo + force)
    await assert.rejects(
      () => core.agent({ project: "MyFilm", scenes: ["s1"], scene_references: [[], []] }),
      /scene_references has 2 entries/,
    );
    await assert.rejects(
      () => core.agent({ project: "MyFilm", scenes: ["s1"], references: [{ name: "Hero", image: "asset:Hero" }], scene_references: [["Ghost"]] }),
      /not in references/,
    );
    await assert.rejects(
      () => core.agent({ project: "MyFilm", scenes: ["s1"], references: [{ name: "Hero", image: join(root, "missing.png") }] }),
      /Reference image not found/,
    );
    const refFile = join(root, "ref.png");
    writeFileSync(refFile, "png");
    writeFileSync(join(filmDir, "scene-05.png"), "img");
    await core.agent({
      project: "MyFilm",
      scenes: ["s1"],
      references: [{ name: "Hero", image: refFile }],
      scene_references: [["Hero"]],
    });
    await core.agent({ project: "BrandNewProj2", scenes: ["s1"] });
    await core.edit({ project: "MyFilm", asset: "Clip1", prompt: "brighter" });
    await core.wait({ timeout_seconds: 5 });
    await assert.rejects(
      () => core.continue_shot({ project: "MyFilm", from_asset: "Hero Shot", prompt: "next" }),
      /already holds a recent clip/,
    );
    await core.continue_shot({ project: "MyFilm", from_asset: "Unrelated Clip", prompt: "next" });
    await core.continue_shot({ project: "MyFilm", from_asset: "Hero Shot", prompt: "next", force: true });
    await core.wait({ timeout_seconds: 5 });
    assert.ok(calls.some((c) => c.startsWith("agent:")));
    assert.ok(calls.some((c) => c.startsWith("edit:")));
    assert.ok(calls.some((c) => c.startsWith("cont:")));

    // assets, download, assemble, trash, discard
    assert.equal((await core.assets({})).length, 4);
    assert.equal((await core.assets({ kind: "image" })).length, 1);
    await assert.rejects(() => core.download({ project: "MyFilm", assets: [] }), /Name the assets/);
    const dlDir = join(cfg.outputRoot, "DlProj");
    mkdirSync(dlDir, { recursive: true });
    writeFileSync(join(dlDir, "clip-02.mp4"), "x");
    writeFileSync(join(dlDir, "readme.txt"), "x");
    const dlOut = await core.download({ project: "DlProj", assets: ["Hero"], collection: "Col1" });
    assert.equal(dlOut.files.length, 2);
    await assert.rejects(() => core.download({ project: "DlProj", assets: ["throw-err"] }), /dl error/);
    await assert.rejects(() => core.download({ project: "DlProj", assets: ["throw-str"] }), /dl str/);

    await core.assemble({ project: "MyFilm", clips: ["a.mp4"], output_name: "cut" });
    await core.assemble({
      project: "MyFilm",
      clips: ["a.mp4"],
      output_name: "cut 2",
      voice_lines: [{ text: "hello", at: 0 }],
    });
    assert.deepEqual(await core.trash({ name: "Old" }), { trashed: "Old" });

    await assert.rejects(() => core.discard({ path: cfg.outputRoot }), (e: AppError) => e.code === ERROR_CODES.PATH_OUTSIDE_ALLOWLIST);
    await assert.rejects(() => core.discard({ path: root }), (e: AppError) => e.code === ERROR_CODES.PATH_OUTSIDE_ALLOWLIST);
    await assert.rejects(() => core.discard({ path: join(filmDir, "missing.mp4") }), (e: AppError) => e.code === ERROR_CODES.NOT_FOUND);
    const killTarget = join(filmDir, "trashme.mp4");
    writeFileSync(killTarget, "v");
    assert.equal((await core.discard({ path: killTarget })).trashed, killTarget);

    // character & character_edit
    await assert.rejects(() => core.character({ name: "X" }), /Pass either/);
    await core.character({ name: "A", describe: "red hat" });
    await core.character({ name: "B", image: refFile, look: "blue coat" });
    await core.character({ name: "C", image: refFile });
    await core.character_edit({ name: "A", look: "new look" });
    await core.character_edit({ name: "A", change: "add glasses." });
    await core.character_edit({ name: "NewChar", change: "short hair" });
    await core.character_edit({ name: "C" });

    // set_key, voices, narrate, transcribe, caption_preview, captions, presenter, caption_setup, techniques
    assert.equal((await core.set_key({ key: "AIza1234567890" })).ending, "7890");
    assert.equal((await core.voices()).gemini_ready, true);
    const narDir = join(cfg.outputRoot, "NarProj");
    mkdirSync(narDir, { recursive: true });
    writeFileSync(join(narDir, "narration-01.m4a"), "a");
    writeFileSync(join(narDir, "notes.txt"), "n");
    assert.equal((await core.narrate({ project: "NarProj", text: "Hi", engine: "kokoro" })).engine, "kokoro");
    assert.equal((await core.narrate({ project: "NarProj", text: "Hi", engine: "kokoro", voice: "af_bella" })).voice, "af_bella");
    assert.equal((await core.narrate({ project: "NarProj", text: "Hi", engine: "gemini" })).voice, "Charon");
    assert.equal((await core.narrate({ project: "NarProj", text: "Hi", engine: "gemini", voice: "QuotaErr" })).fell_back_from, "gemini");
    await assert.rejects(() => core.narrate({ project: "NarProj", text: "Hi", engine: "gemini", voice: "FatalErr" }), /invalid key/);

    assert.equal((await core.transcribe({ video: "v.mp4", words: false })).word_count, 1);
    assert.equal((await core.transcribe({ video: "v.mp4", words: true })).words?.length, 1);
    await core.caption_preview({ video: "v.mp4", style: "bold", position: "bottom", size: "medium", letters: "as_said", words_per_line: 3, format: "png", fade: 0 });
    await core.captions({ project: "CapProj", video: "v.mp4", style: "bold", position: "bottom", size: "medium", letters: "as_said", words_per_line: 3, fade: 0 });
    await core.captions({ video: join(filmDir, "scene-01.mp4"), style: "bold", position: "bottom", size: "medium", letters: "as_said", words_per_line: 3, fade: 0 });
    await core.captions({ video: join(root, "outside.mp4"), style: "bold", position: "bottom", size: "medium", letters: "as_said", words_per_line: 3, fade: 0 });
    await core.presenter({ project: "MyFilm", video: "v.mp4", scenes: [] });
    assert.equal((await core.caption_setup()).ready, true);
    assert.ok((await core.techniques({})).length > 0);
    assert.ok((await core.techniques({ category: "camera" })).every((t) => t.category === "camera"));

    // Standalone *Here exports & setCoreMediaDeps
    setCoreMediaDeps(mediaStub);
    assert.equal((await voicesHere()).kokoro_ready, true);
    assert.equal((await narrateHere({ project: "NarProj", text: "Hey", engine: "kokoro" })).engine, "kokoro");
    assert.equal((await transcribeHere({ video: "v.mp4" })).text, "hi");
    await presenterHere({ project: "MyFilm", video: "v.mp4", scenes: [] });
    await captionPreviewHere({ video: "v.mp4", style: "bold", position: "bottom", size: "medium", letters: "as_said", words_per_line: 3, format: "png", fade: 0 });
    await captionsHere({ project: "CapProj", video: "v.mp4", style: "bold", position: "bottom", size: "medium", letters: "as_said", words_per_line: 3, fade: 0 });
    assert.equal((await captionSetupHere()).ready, true);
    setCoreMediaDeps();

    // runQueuedJob without job.accountId + file_stem without digits branch
    const orphanQ = new JobQueue(async () => ["a.mp4"]);
    const orphanJob = {
      id: "orph",
      status: "running" as const,
      params: { prompt: "x", type: "image" as const, max_credits: 0, output_dir: filmDir, file_stem: "nodigit" },
      files: [],
      attempts: 1,
      createdAt: "",
    };
    let synced = false;
    await runQueuedJob(orphanJob, orphanQ, { ...mediaStub, runGeneration: async () => ["x.png"] } as CoreMediaDeps, async () => {
      synced = true;
    });
    assert.equal(synced, false);

    // Next stem with non-digit file_stem queued in same dir
    const q3 = new LocalCore({ getConfig: () => cfg, chrome, store, flow: flowDriver, media: mediaStub, waitPollMs: 5 });
    q3["queue"].add({ prompt: "x", type: "image", max_credits: 0, output_dir: filmDir, file_stem: "scene-alpha" });
    await q3.agent({ project: "MyFilm", scenes: ["s2"] });
    await q3.generate({ project: "MyFilm", scenes: [{ prompt: "s", type: "image", max_credits: 0 }] });
    await q3.wait({ timeout_seconds: 5 });

    // Remove disabled/inactive secondary
    await core.account_switch({ id: "default" });
    await core.account_remove({ id: added.account.id });

    // Corrupt store outputs() branch returns includeCastDir=false
    const corruptCfg = getConfig({ FLOW_MCP_HOME: join(root, "corrupt"), FLOW_MCP_OUTPUT: cfg.outputRoot });
    mkdirSync(corruptCfg.homeDir, { recursive: true });
    writeFileSync(corruptCfg.accountsFile, "{broken");
    const corruptCore = new LocalCore({ getConfig: () => corruptCfg, chrome, media: mediaStub });
    assert.ok(corruptCore.getRegistryError());
    assert.equal(getActiveAccountPaths().lastProjectUrl, undefined);
    const corruptOuts = await corruptCore.outputs();
    assert.equal(corruptOuts.projects.some((p) => p.name === "_cast"), false);
  } finally {
    setCoreMediaDeps();
    setDefaultChromeManager(new ChromeManager());
    if (prevHome === undefined) delete process.env.FLOW_MCP_HOME;
    else process.env.FLOW_MCP_HOME = prevHome;
    if (prevOut === undefined) delete process.env.FLOW_MCP_OUTPUT;
    else process.env.FLOW_MCP_OUTPUT = prevOut;
    if (prevMin === undefined) delete process.env.FLOW_MCP_PAUSE_MIN_S;
    else process.env.FLOW_MCP_PAUSE_MIN_S = prevMin;
    if (prevMax === undefined) delete process.env.FLOW_MCP_PAUSE_MAX_S;
    else process.env.FLOW_MCP_PAUSE_MAX_S = prevMax;
    rmSync(root, { recursive: true, force: true });
  }
});

test("LocalCore active project URL wiring preserves lastProjectUrl across cold restart, crash recovery, and open home tab reuse", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-cold-url-"));
  const prevHome = process.env.FLOW_MCP_HOME;
  const prevOut = process.env.FLOW_MCP_OUTPUT;
  const prevPort = process.env.FLOW_MCP_CDP_PORT;
  const homeDir = join(root, "home");
  const outDir = join(root, "out");
  process.env.FLOW_MCP_HOME = homeDir;
  process.env.FLOW_MCP_OUTPUT = outDir;
  process.env.FLOW_MCP_CDP_PORT = "9462";

  try {
    const cfg = getConfig();
    mkdirSync(join(cfg.homeDir, "chrome-profile"), { recursive: true });
    const projectUrl = "https://flow.google.com/project/11111111-1111-1111-1111-111111111111";

    const seedStore = new AccountStore(cfg);
    seedStore.updateMetadata("default", { lastProjectUrl: projectUrl, needsRelogin: false });
    const backup = seedStore.addAccount("Backup");
    seedStore.updateMetadata(backup.id, { needsRelogin: false });

    const makeHarnessChrome = (init?: { cdpUp?: boolean; profile?: string; url?: string }) => {
      let cdpUp = init?.cdpUp ?? false;
      let curProfile = init?.profile ?? "";
      let curUrl = init?.url ?? "";
      const launchedUrls: string[] = [];
      const page = {
        url: () => curUrl,
        goto: async (u: string) => { curUrl = u; },
        bringToFront: async () => undefined,
        evaluate: async () => "en",
        waitForFunction: async () => undefined,
      } as never;
      const browser = {
        isConnected: () => cdpUp,
        contexts: () => [{ pages: () => (curUrl ? [page] : []), newPage: async () => page }],
        newBrowserCDPSession: async () => ({ send: async () => undefined }),
        close: async () => { cdpUp = false; },
        on: () => undefined,
      } as never;
      const chrome = new ChromeManager({
        getConfig: () => cfg,
        cdpProbe: async () => ({ ok: cdpUp, isCdp: cdpUp }),
        connectOverCDP: async () => browser,
        spawnChrome: (_b, args) => {
          curProfile = args.find((a) => a.startsWith("--user-data-dir="))!.slice("--user-data-dir=".length);
          curUrl = args[args.length - 1];
          launchedUrls.push(curUrl);
          cdpUp = true;
          return 901;
        },
        listProcesses: async () =>
          cdpUp ? [{ pid: 901, command: `chrome --user-data-dir=${curProfile} --remote-debugging-port=${cfg.cdpPort}` }] : [],
        isPidAlive: () => cdpUp,
        killPid: () => { cdpUp = false; },
        executable: () => "/usr/bin/chrome",
        sleep: async () => undefined,
        launchTimeoutMs: 50,
        closeTimeoutMs: 20,
        termTimeoutMs: 20,
      });
      return { chrome, launchedUrls, setUrl: (u: string) => { curUrl = u; }, getProfile: () => curProfile };
    };

    // 1. Cold restart: persisted lastProjectUrl is wired via getActiveAccountPaths() into getFlowState & requireFlowProject
    const coldHarness = makeHarnessChrome();
    const coldCore = new LocalCore({ getConfig: () => cfg, chrome: coldHarness.chrome });
    assert.equal(getActiveAccountPaths().lastProjectUrl, projectUrl);
    const coldState = await getFlowState();
    assert.equal(coldState.signedIn, true);
    assert.equal(coldState.inProject, true);
    assert.equal(coldHarness.launchedUrls[0], `${projectUrl}?hl=en`);
    const coldPage = await requireFlowProject();
    assert.equal(coldPage.url(), `${projectUrl}?hl=en`);
    assert.equal(coldCore.store.findAccount({ id: "default" }).lastProjectUrl, projectUrl);

    // 2. Open Flow home tab stays reused (deleted-project !inProject detection preserved)
    coldHarness.setUrl("https://flow.google.com/?hl=en");
    const homeState = await getFlowState();
    assert.equal(homeState.signedIn, true);
    assert.equal(homeState.inProject, false);
    await coldCore.close();

    // 3. Crash recovery: pendingFailover reverts to default and reclaims orphaned candidate Chrome onto Primary's lastProjectUrl
    const crashStore = new AccountStore(cfg);
    crashStore.setPendingFailover({ originalAccountId: "default", candidateAccountId: backup.id, startedAt: new Date().toISOString() });
    crashStore.setActive(backup.id, null);
    const backupProfile = crashStore.getPaths(crashStore.findAccount({ id: backup.id })).profileDir;
    const crashHarness = makeHarnessChrome({
      cdpUp: true,
      profile: backupProfile,
      url: "https://flow.google.com/?hl=en",
    });
    const recoveredCore = new LocalCore({
      getConfig: () => cfg,
      chrome: crashHarness.chrome,
      flow: {
        getFlowState: async () => getFlowState(false),
        createProject: async () => ({ id: "1", url: projectUrl, title: "P" }),
        listCharacters: async () => [],
      },
    });
    assert.equal(recoveredCore.store.requireActiveAccount().id, "default");
    assert.equal(getActiveAccountPaths().lastProjectUrl, projectUrl);
    const refreshed = await recoveredCore.account_refresh({});
    assert.equal(refreshed.refreshed, true);
    assert.equal(crashHarness.getProfile(), recoveredCore.store.getActivePaths().profileDir);
    assert.equal(crashHarness.launchedUrls[0], `${projectUrl}?hl=en`);
    assert.equal(recoveredCore.store.findAccount({ id: "default" }).lastProjectUrl, projectUrl);
    await recoveredCore.close();
  } finally {
    setDefaultChromeManager(new ChromeManager());
    if (prevHome === undefined) delete process.env.FLOW_MCP_HOME;
    else process.env.FLOW_MCP_HOME = prevHome;
    if (prevOut === undefined) delete process.env.FLOW_MCP_OUTPUT;
    else process.env.FLOW_MCP_OUTPUT = prevOut;
    if (prevPort === undefined) delete process.env.FLOW_MCP_CDP_PORT;
    else process.env.FLOW_MCP_CDP_PORT = prevPort;
    rmSync(root, { recursive: true, force: true });
  }
});
