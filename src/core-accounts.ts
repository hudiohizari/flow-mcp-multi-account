import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AppError, ERROR_CODES } from "./errors.js";
import { t } from "./i18n.js";
import type { Job, JobQueue } from "./queue.js";

export function buildJobView(job: Job) {
  return {
    id: job.id,
    status: job.status,
    accountId: job.accountId,
    accountLabel: job.accountLabel,
    portable: job.portable,
    failoverFrom: job.failoverFrom,
    failoverAttempts: job.failoverAttempts,
    errorCode: job.errorCode,
    project: job.params.output_dir,
    scene: job.params.file_stem,
    prompt: job.params.prompt,
    attempts: job.attempts,
    credits: job.credits,
    progress: job.progress,
    files: job.files,
    note: job.note,
    error: job.error,
    failed_scenes: job.failed_scenes,
  };
}

function mismatchError(job: Job, active: { id: string; label: string }): AppError {
  const owner = job.accountLabel ?? job.accountId!;
  return new AppError(
    409,
    ERROR_CODES.ACCOUNT_MISMATCH,
    t("error.ACCOUNT_MISMATCH", { expectedLabel: owner, activeLabel: active.label }),
    {
      jobId: job.id,
      ownerAccountId: job.accountId,
      ownerAccountLabel: owner,
      activeAccountId: active.id,
      activeLabel: active.label,
    },
  );
}

export function guardRetry(
  queue: JobQueue,
  active: { id: string; label: string },
  jobIds?: string[],
): Job[] {
  if (jobIds !== undefined) {
    if (jobIds.length === 0) {
      throw new AppError(400, ERROR_CODES.NOTHING_TO_RETRY, t("error.NOTHING_TO_RETRY"));
    }
    const targets: Job[] = [];
    for (const id of jobIds) {
      const job = queue.get(id);
      if (!job) continue;
      const retryable = job.status === "failed" || job.status === "cancelled" || Boolean(job.failed_scenes?.length);
      if (retryable && !job.portable && job.accountId && job.accountId !== active.id) {
        throw mismatchError(job, active);
      }
      targets.push(job);
    }
    const retried: Job[] = [];
    for (const job of targets) {
      const p = job.params;
      const partialAgent =
        Boolean(job.failed_scenes?.length && p.agent_scenes) &&
        (job.status === "done" || (job.status === "failed" && job.files.length > 0));
      if (partialAgent) {
        const base = Number(p.file_stem.match(/\d+/)?.[0] ?? 1);
        const numbers = p.agent_numbers ?? p.agent_scenes!.map((_, i) => base + i);
        const pick = job.failed_scenes!.map((n) => numbers.indexOf(n)).filter((i) => i >= 0);
        if (pick.length > 0) {
          job.failed_scenes = undefined;
          retried.push(
            queue.add(
              {
                ...p,
                agent_ref_assets: undefined,
                prompt: `Agent batch: ${pick.length} failed image(s) again`,
                agent_scenes: pick.map((i) => p.agent_scenes![i]),
                agent_numbers: pick.map((i) => numbers[i]),
                agent_scene_refs: p.agent_scene_refs ? pick.map((i) => p.agent_scene_refs![i]) : undefined,
                file_stem: `scene-${String(numbers[pick[0]]).padStart(2, "0")}`,
              },
              { accountId: active.id, accountLabel: active.label, portable: job.portable },
            ),
          );
          continue;
        }
      }
      if (job.status === "failed" || job.status === "cancelled") {
        const ownerOverride = job.portable ? { accountId: active.id, accountLabel: active.label } : undefined;
        const again = queue.retry(job.id, ownerOverride);
        if (again) retried.push(again);
      }
    }
    if (!retried.length) throw new AppError(400, ERROR_CODES.NOTHING_TO_RETRY, t("error.NOTHING_TO_RETRY"));
    return retried;
  }

  const retryable = queue
    .list()
    .filter((j) => j.status === "failed" || j.status === "cancelled" || Boolean(j.failed_scenes?.length));
  if (!retryable.length) throw new AppError(400, ERROR_CODES.NOTHING_TO_RETRY, t("error.NOTHING_TO_RETRY"));
  const eligible = retryable.filter((j) => j.portable || !j.accountId || j.accountId === active.id);
  if (!eligible.length) throw mismatchError(retryable[0], active);
  return guardRetry(queue, active, eligible.map((j) => j.id));
}

export function resolveCastPortraits(
  names: string[],
  castDir: string,
): { name: string; use_as: string; portrait?: string }[] {
  const files = existsSync(castDir)
    ? readdirSync(castDir).filter((f) => /\.(jpe?g|png|webp|gif)$/i.test(f))
    : [];
  return names.map((name) => {
    const safe = name.replace(/[^\w.-]+/g, "_").toLowerCase();
    const match = files.find((f) => {
      const low = f.toLowerCase();
      const stem = low.replace(/\.[^.]+$/, "");
      return stem === safe || stem.startsWith(`${safe}-`);
    });
    return {
      name,
      use_as: `asset:${name}`,
      ...(match ? { portrait: join(castDir, match) } : {}),
    };
  });
}

export function filterAccountOutputs(outputRoot: string, includeCastDir: boolean) {
  if (!existsSync(outputRoot)) return { root: outputRoot, projects: [] };
  const media = /\.(mp4|webm|mov|gif|jpe?g|png|webp|m4a|mp3|wav|aiff?)$/i;
  const projects = readdirSync(outputRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && (includeCastDir || d.name !== "_cast"))
    .map((d) => {
      const dir = join(outputRoot, d.name);
      const files = readdirSync(dir)
        .filter((f) => media.test(f) && !f.endsWith("-lastframe.jpg"))
        .map((f) => ({
          name: f,
          path: join(dir, f),
          kind: /\.(mp4|webm|mov)$/i.test(f) ? "video" : /\.(m4a|mp3|wav|aiff?)$/i.test(f) ? "audio" : "image",
          mtime: statSync(join(dir, f)).mtimeMs,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { name: d.name, dir, files, mtime: Math.max(0, ...files.map((f) => f.mtime)) };
    })
    .filter((p) => p.files.length)
    .sort((a, b) => b.mtime - a.mtime);
  return { root: outputRoot, projects };
}
