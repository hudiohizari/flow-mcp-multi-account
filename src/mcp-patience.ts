import { randomUUID } from "node:crypto";
import type { Core } from "./core.js";
import { AppError } from "./errors.js";

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export interface PatienceTask {
  task_id: string;
  tool: string;
  started: string;
  status: "running" | "done" | "failed";
  result?: unknown;
  error?: string;
}

export function createPatienceRunner(core: Pick<Core, "wait">, patienceMs: number) {
  const waitMs = Math.max(5_000, patienceMs - 5_000);
  const tasks = new Map<string, PatienceTask>();

  const reply = async (work: Promise<unknown>, extra: object = {}): Promise<ToolResult> => {
    try {
      const data = await work;
      const body = Array.isArray(data) ? data : { ...(data as object), ...extra };
      return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
    } catch (err) {
      const payload =
        err instanceof AppError
          ? { error: err.message, code: err.code, ...(err.meta ? { meta: err.meta } : {}) }
          : { error: err instanceof Error ? err.message : String(err) };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
    }
  };

  const patient = async (tool: string, work: Promise<unknown>): Promise<unknown> => {
    const task: PatienceTask = {
      task_id: `task-${randomUUID().slice(0, 8)}`,
      tool,
      started: new Date().toISOString(),
      status: "running",
    };
    const settled = work.then(
      (result) => {
        task.status = "done";
        task.result = result;
      },
      (err) => {
        task.status = "failed";
        task.error = err instanceof Error ? err.message : String(err);
      },
    );
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((r) => (timer = setTimeout(() => r("late"), patienceMs)));
    const first = await Promise.race([settled.then(() => "settled" as const), late]);
    clearTimeout(timer);
    if (first === "settled") return work;
    tasks.set(task.task_id, task);
    return {
      still_working: true,
      task_id: task.task_id,
      note: `Flow is still on it - this is not a failure. Call flow_wait with job_ids ["${task.task_id}"] for the result, and do not call ${tool} again: the work has not stopped.`,
    };
  };

  async function waitFor({ job_ids, timeout_seconds }: { job_ids?: string[]; timeout_seconds: number }): Promise<unknown> {
    const deadline = Date.now() + Math.min(timeout_seconds * 1000, waitMs);
    const isTask = (id: string) => tasks.has(id) || id.startsWith("task-");
    const mine = (job_ids ?? []).filter(isTask);
    const jobs = job_ids?.filter((id) => !isTask(id));
    while (Date.now() < deadline && mine.some((id) => tasks.get(id)?.status === "running")) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    const done = mine.map(
      (id) =>
        tasks.get(id) ?? {
          task_id: id,
          status: "unknown",
          note: "This tool restarted since that call, so its answer is lost. Check Flow (flow_assets, flow_characters) for what it did before running it again.",
        },
    );
    const tasksFinished = done.every((item) => item.status !== "running");
    if (mine.length && !jobs?.length) return { finished: tasksFinished, tasks: done };
    const left = Math.max(5, Math.floor((deadline - Date.now()) / 1000));
    const queued = (await core.wait({ job_ids: jobs, timeout_seconds: left })) as { finished: boolean };
    return mine.length ? { ...queued, finished: queued.finished && tasksFinished, tasks: done } : queued;
  }

  const slowCalls = () => [...tasks.values()].map(({ result: _ignored, ...rest }) => rest);

  return { reply, patient, waitFor, slowCalls, hasSlowCalls: () => tasks.size > 0 };
}
