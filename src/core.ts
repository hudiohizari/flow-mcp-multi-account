import { AccountFailoverCoordinator } from "./account-failover.js";
import { setActiveAccountPathsResolver } from "./account-paths.js";
import { AccountService, type FlowDriver } from "./account-service.js";
import { AccountStore } from "./accounts.js";
import { ChromeManager, setDefaultChromeManager } from "./chrome.js";
import { getConfig, projectDir, type FlowConfig } from "./config.js";
import { buildJobView, filterAccountOutputs, guardRetry, resolveCastPortraits } from "./core-accounts.js";
import {
  assembleFilmOp,
  buildAgentJob,
  buildSceneJobs,
  captionPreviewWithDeps,
  captionSetupWithDeps,
  captionsWithDeps,
  createCharacterOp,
  defaultCoreMediaDeps,
  discardFileOp,
  downloadAssetsOp,
  editCharacterOp,
  findContinueEcho,
  narrateWithDeps,
  nextStem,
  presenterWithDeps,
  runQueuedJob,
  transcribeWithDeps,
  voicesWithDeps,
  type CoreMediaDeps,
} from "./core-media.js";
import { AppError, ERROR_CODES } from "./errors.js";
import { createProject, getFlowState, listCharacters } from "./flow.js";
import { t } from "./i18n.js";
import { JobQueue, type Job } from "./queue.js";
import { type Args } from "./schemas.js";
import { TECHNIQUES } from "./techniques.js";

export { shapes, type Args } from "./schemas.js";
export {
  VOICES,
  captionPreviewHere,
  captionSetupHere,
  captionsHere,
  narrateHere,
  presenterHere,
  transcribeHere,
  voicesHere,
} from "./core-media.js";
export const jobView = buildJobView;

export interface Core {
  status(a: Args<"status">): Promise<unknown>;
  generate(a: Args<"generate">): Promise<unknown>;
  wait(a: Args<"wait">): Promise<unknown>;
  cancel(a: Args<"cancel">): Promise<unknown>;
  retry(a: Args<"retry">): Promise<unknown>;
  assets(a: Args<"assets">): Promise<unknown>;
  download(a: Args<"download">): Promise<unknown>;
  assemble(a: Args<"assemble">): Promise<unknown>;
  techniques(a: Args<"techniques">): Promise<unknown>;
  voices(): Promise<unknown>;
  narrate(a: Args<"narrate">): Promise<unknown>;
  new_project(a: Args<"new_project">): Promise<unknown>;
  character(a: Args<"character">): Promise<unknown>;
  characters(): Promise<unknown>;
  cast(): Promise<unknown>;
  character_edit(a: Args<"character_edit">): Promise<unknown>;
  edit(a: Args<"edit">): Promise<unknown>;
  trash(a: Args<"trash">): Promise<unknown>;
  discard(a: Args<"discard">): Promise<unknown>;
  set_key(a: Args<"set_key">): Promise<unknown>;
  continue_shot(a: Args<"continue_shot">): Promise<unknown>;
  agent(a: Args<"agent">): Promise<unknown>;
  outputs(): Promise<unknown>;
  transcribe(a: Args<"transcribe">): Promise<unknown>;
  caption_preview(a: Args<"caption_preview">): Promise<unknown>;
  captions(a: Args<"captions">): Promise<unknown>;
  presenter(a: Args<"presenter">): Promise<unknown>;
  caption_setup(): Promise<unknown>;
  accounts(): Promise<unknown>;
  account_add(a: Args<"account_add">): Promise<unknown>;
  account_switch(a: Args<"account_switch">): Promise<unknown>;
  account_login(a: Args<"account_login">): Promise<unknown>;
  account_rename(a: Args<"account_rename">): Promise<unknown>;
  account_enable(a: Args<"account_enable">): Promise<unknown>;
  account_reorder(a: Args<"account_reorder">): Promise<unknown>;
  account_remove(a: Args<"account_remove">): Promise<unknown>;
  account_refresh(a: Args<"account_refresh">): Promise<unknown>;
  account_config(a: Args<"account_config">): Promise<unknown>;
}

export interface LocalCoreDeps {
  getConfig?: () => FlowConfig;
  chrome?: ChromeManager;
  store?: AccountStore;
  flow?: FlowDriver;
  media?: Partial<CoreMediaDeps>;
  waitPollMs?: number;
}

export class LocalCore implements Core {
  private cfg: () => FlowConfig;
  private flow: FlowDriver;
  private media: CoreMediaDeps;
  private waitPollMs: number;
  readonly chrome: ChromeManager;
  readonly store: AccountStore;
  readonly accountService: AccountService;
  readonly failover: AccountFailoverCoordinator;
  private queue: JobQueue;

  constructor(deps: LocalCoreDeps = {}) {
    this.cfg = deps.getConfig ?? getConfig;
    this.chrome = deps.chrome ?? new ChromeManager();
    this.store = deps.store ?? new AccountStore(this.cfg());
    this.chrome.setAbandonedProfileDir(this.store.getAbandonedCandidateProfileDir());
    this.store.clearAbandonedCandidateProfileDir();
    this.flow = deps.flow ?? { getFlowState, createProject, listCharacters };
    this.media = { ...defaultCoreMediaDeps(), getConfig: this.cfg, ...deps.media };
    this.waitPollMs = deps.waitPollMs ?? 3000;
    setDefaultChromeManager(this.chrome);
    setActiveAccountPathsResolver(() => ({
      ...this.store.getActivePaths(),
      lastProjectUrl: this.store.getActiveAccount()?.lastProjectUrl,
    }));

    this.queue = new JobQueue(
      (job) => runQueuedJob(job, this.queue, this.media, (id) => this.accountService.syncPostJobReadout(id), this.failover),
      () => {
        const c = this.cfg();
        return { minMs: c.pauseMinMs, maxMs: c.pauseMaxMs };
      },
    );

    this.accountService = new AccountService({
      store: this.store,
      chrome: this.chrome,
      queue: this.queue,
      getConfig: this.cfg,
      flow: this.flow,
    });
    this.failover = new AccountFailoverCoordinator({
      store: this.store,
      chrome: this.chrome,
      flow: this.flow,
      hooks: this.accountService.getInternalSwitchHooks(),
    });
    this.accountService.setFailoverPhaseProvider(() => this.failover.getPhase());
  }

  getRegistryError(): string | null {
    return this.store.getRegistryError();
  }

  getActiveCastDir(): string {
    return this.accountService.getActiveCastDir();
  }

  async close(): Promise<void> {
    this.failover.requestAbort();
    await this.chrome.closeChromeSerialized().catch(() => {});
    this.failover.revertPendingIfNeeded();
  }

  async status({ detailed }: Args<"status">) {
    return this.accountService.getStatus(detailed);
  }

  async accounts() {
    return this.accountService.listAccounts();
  }

  async account_add({ label }: Args<"account_add">) {
    return this.accountService.addAccount(label);
  }

  async account_switch(a: Args<"account_switch">) {
    return this.accountService.switchAccount(a);
  }

  async account_login(a: Args<"account_login">) {
    return this.accountService.loginAccount(a);
  }

  async account_rename(a: Args<"account_rename">) {
    return this.accountService.renameAccount(a, a.label);
  }

  async account_enable(a: Args<"account_enable">) {
    return this.accountService.enableAccount(a, a.enabled);
  }

  async account_reorder({ ids }: Args<"account_reorder">) {
    return this.accountService.reorderAccounts(ids);
  }

  async account_remove(a: Args<"account_remove">) {
    return this.accountService.removeAccount(a);
  }

  async account_refresh(a: Args<"account_refresh">) {
    return this.accountService.refreshAccount(a);
  }

  async account_config({ auto_failover }: Args<"account_config">) {
    return this.accountService.configureFailover(auto_failover);
  }

  async generate(a: Args<"generate">) {
    const owner = this.accountService.requireActiveAccount();
    const { output_dir, jobs } = buildSceneJobs(a, this.cfg().outputRoot, this.queue, owner, this.media.characterLook);
    return { output_dir, jobs: jobs.map(jobView) };
  }

  async wait({ job_ids, timeout_seconds }: Args<"wait">) {
    const pick = () => (job_ids ? job_ids.map((id) => this.queue.get(id)).filter((j): j is Job => Boolean(j)) : this.queue.list());
    const deadline = Date.now() + timeout_seconds * 1000;
    while (Date.now() < deadline && pick().some((j) => j.status === "queued" || j.status === "running")) {
      await new Promise((r) => setTimeout(r, this.waitPollMs));
    }
    const jobs = pick();
    return {
      finished: jobs.every((j) => j.status !== "queued" && j.status !== "running"),
      pacing: this.queue.pausedReason,
      jobs: jobs.map(jobView),
    };
  }

  async cancel({ job_id }: Args<"cancel">) {
    const job = this.queue.cancel(job_id);
    if (!job) throw new AppError(404, ERROR_CODES.JOB_NOT_FOUND, t("error.JOB_NOT_FOUND", { jobId: job_id }));
    return jobView(job);
  }

  async retry({ job_ids }: Args<"retry">) {
    const active = this.accountService.requireActiveAccount();
    return { jobs: guardRetry(this.queue, active, job_ids).map(jobView) };
  }

  async assets({ kind }: Args<"assets">) {
    return this.accountService.wrapChromeOp(async () =>
      (await this.media.listAssets()).filter((a) => !kind || a.kind === kind).map(({ name, kind: k }) => ({ name, kind: k })),
    );
  }

  async download(a: Args<"download">) {
    return this.accountService.wrapChromeOp(() => downloadAssetsOp(a, this.cfg().outputRoot, this.media));
  }

  async assemble(a: Args<"assemble">) {
    return assembleFilmOp(a, this.cfg().outputRoot, this.media);
  }

  transcribe = (a: Args<"transcribe">) => transcribeWithDeps(a, this.media);
  caption_preview = (a: Args<"caption_preview">) => captionPreviewWithDeps(a, this.media);
  captions = (a: Args<"captions">) => captionsWithDeps(a, this.media);
  presenter = (a: Args<"presenter">) => presenterWithDeps(a, this.media);
  caption_setup = () => captionSetupWithDeps(this.media);

  async outputs() {
    const active = this.store.getActiveAccount();
    return filterAccountOutputs(this.cfg().outputRoot, active ? active.isDefault : false);
  }

  async agent(a: Args<"agent">) {
    const owner = this.accountService.requireActiveAccount();
    const { output_dir, job } = buildAgentJob(a, this.cfg().outputRoot, this.queue, owner);
    return { output_dir, jobs: [jobView(job)] };
  }

  async edit({ project, asset, prompt, download_quality }: Args<"edit">) {
    const owner = this.accountService.requireActiveAccount();
    const output_dir = projectDir(project, this.cfg().outputRoot);
    const job = this.queue.add(
      { prompt, type: "video", max_credits: 0, edit_asset: asset, download_quality, output_dir, file_stem: nextStem(this.queue, output_dir, "edit") },
      { accountId: owner.id, accountLabel: owner.label },
    );
    return { output_dir, jobs: [jobView(job)] };
  }

  async continue_shot({ project, from_asset, prompt, attach, aspect_ratio, mode, download_quality, force }: Args<"continue_shot">) {
    const owner = this.accountService.requireActiveAccount();
    if (!force) await this.accountService.wrapChromeOp(() => findContinueEcho(from_asset, this.media));
    const output_dir = projectDir(project, this.cfg().outputRoot);
    const job = this.queue.add(
      { prompt, type: "video", max_credits: 0, continue_from: from_asset, attach, continue_mode: mode, aspect_ratio, download_quality, output_dir, file_stem: nextStem(this.queue, output_dir, "shot") },
      { accountId: owner.id, accountLabel: owner.label },
    );
    return { output_dir, jobs: [jobView(job)] };
  }

  async discard({ path }: Args<"discard">) {
    return discardFileOp(path, this.cfg().outputRoot, this.media.moveToBin);
  }

  async trash({ name }: Args<"trash">) {
    return this.accountService.wrapChromeOp(() => this.media.trashAsset(name));
  }

  async new_project({ title }: Args<"new_project">) {
    const made = await this.accountService.createProjectForActive(title);
    return { ...made, note: "The Flow window now has this empty project open; every generation goes into it. Characters belong to a project, so make them again here." };
  }

  async character(a: Args<"character">) {
    return this.accountService.wrapChromeOp(() => createCharacterOp(a, this.media));
  }

  async character_edit(a: Args<"character_edit">) {
    return this.accountService.wrapChromeOp(() => editCharacterOp(a, this.media));
  }

  async characters() {
    return this.accountService.wrapChromeOp(async () =>
      resolveCastPortraits(await this.flow.listCharacters(), this.accountService.getActiveCastDir()),
    );
  }

  async cast() {
    return this.accountService.wrapChromeOp(async () => {
      const active = this.accountService.requireActiveAccount();
      return { accountId: active.id, characters: resolveCastPortraits(await this.flow.listCharacters(), this.accountService.getActiveCastDir()) };
    });
  }

  async set_key({ key }: Args<"set_key">) {
    return this.media.saveGeminiKey(key);
  }

  voices = () => voicesWithDeps(this.media);
  narrate = (a: Args<"narrate">) => narrateWithDeps(a, this.media);

  async techniques({ category }: Args<"techniques">) {
    return TECHNIQUES.filter((item) => !category || item.category === category);
  }
}
