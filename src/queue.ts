import { randomUUID } from "node:crypto";
import { isJobPortable } from "./account-failover-policy.js";
import { getConfig } from "./config.js";
import { AppError, type ErrorCode } from "./errors.js";

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface FailoverOrigin {
  accountId: string;
  accountLabel: string;
}

export interface FailoverAttempt {
  accountId: string;
  accountLabel: string;
  status: "skipped" | "failed" | "succeeded";
  code?: ErrorCode;
  reason: string;
}

export interface SceneParams {
  prompt: string;
  type: "video" | "image";
  max_credits: number;
  duration?: number;
  resolution?: "360p" | "720p";
  model?: string;
  aspect_ratio?: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  variants?: number;
  first_frame?: string;
  first_frame_at?: number;
  last_frame?: string;
  reference_images?: string[];
  chain_from?: string;
  reference_from?: string;
  edit_asset?: string;
  agent_scenes?: string[];
  agent_numbers?: number[];
  agent_refs?: { image: string; name: string }[];
  agent_scene_refs?: string[][];
  agent_ref_assets?: string[];
  continue_from?: string;
  attach?: string[];
  continue_mode?: "exact" | "likeness";
  retries?: number;
  download_quality?: "original" | "upscaled";
  output_dir: string;
  file_stem: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  accountId?: string;
  accountLabel?: string;
  portable: boolean;
  failoverFrom?: FailoverOrigin;
  failoverAttempts?: FailoverAttempt[];
  errorCode?: ErrorCode;
  params: SceneParams;
  files: string[];
  attempts: number;
  credits?: number;
  progress?: string;
  note?: string;
  error?: string;
  failed_scenes?: number[];
  createdAt: string;
  finishedAt?: string;
}

export type JobRunner = (job: Job) => Promise<string[]>;

export interface JobOwnership {
  accountId?: string;
  accountLabel?: string;
  portable?: boolean;
}

export class JobQueue {
  private runner: JobRunner;
  private jobs = new Map<string, Job>();
  private working = false;
  private lastFinished = 0;
  private getDelayRange: () => { minMs: number; maxMs: number };
  pausedReason: string | null = null;

  constructor(
    runner: JobRunner,
    getDelayRange: () => { minMs: number; maxMs: number } = () => {
      const cfg = getConfig();
      return { minMs: cfg.pauseMinMs, maxMs: cfg.pauseMaxMs };
    },
  ) {
    this.runner = runner;
    this.getDelayRange = getDelayRange;
  }

  add(params: SceneParams, owner?: JobOwnership): Job {
    const job: Job = {
      id: randomUUID().slice(0, 8),
      status: "queued",
      accountId: owner?.accountId,
      accountLabel: owner?.accountLabel,
      portable: owner?.portable ?? isJobPortable(params),
      params,
      files: [],
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    void this.work();
    return job;
  }

  get active(): boolean {
    return this.working || this.list().some((j) => j.status === "running" || j.status === "queued");
  }

  get busy(): boolean {
    return this.active;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()];
  }

  retry(id: string, owner?: { accountId?: string; accountLabel?: string }): Job | undefined {
    const job = this.jobs.get(id);
    if (job && (job.status === "failed" || job.status === "cancelled")) {
      job.status = "queued";
      job.error = undefined;
      job.errorCode = undefined;
      job.finishedAt = undefined;
      job.failoverFrom = undefined;
      job.failoverAttempts = undefined;
      if (job.params.agent_ref_assets) job.params.agent_ref_assets = undefined;
      if (owner?.accountId) {
        job.accountId = owner.accountId;
        job.accountLabel = owner.accountLabel;
      }
      void this.work();
    }
    return job;
  }

  cancel(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (job && job.status === "queued") {
      job.status = "cancelled";
      job.finishedAt = new Date().toISOString();
    }
    return job;
  }

  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      for (;;) {
        const job = this.list().find((j) => j.status === "queued");
        if (!job) return;
        if (this.lastFinished) {
          const { minMs, maxMs } = this.getDelayRange();
          const pause = minMs + Math.random() * (maxMs - minMs);
          const remaining = this.lastFinished + pause - Date.now();
          if (remaining > 0) {
            this.pausedReason = `pacing: next generation in ${Math.ceil(remaining / 1000)}s`;
            await new Promise((r) => setTimeout(r, remaining));
            this.pausedReason = null;
          }
        }
        if (job.status !== "queued") continue;
        job.status = "running";
        job.attempts++;
        try {
          job.files = await this.runner(job);
          job.status = "done";
          job.error = undefined;
          job.errorCode = undefined;
        } catch (err) {
          job.error = err instanceof Error ? err.message : String(err);
          job.errorCode = err instanceof AppError ? err.code : undefined;
          const retryable = /agent finished without creating/i.test(job.error);
          job.status = retryable && job.attempts <= (job.params.retries ?? 1) ? "queued" : "failed";
        }
        job.finishedAt = new Date().toISOString();
        this.lastFinished = Date.now();
      }
    } finally {
      this.working = false;
    }
  }
}
