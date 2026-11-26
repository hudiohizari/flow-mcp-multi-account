import { readFileSync } from "node:fs";
import { getConfig, type FlowConfig } from "./config.js";
import {
  captionPreviewHere,
  captionSetupHere,
  captionsHere,
  narrateHere,
  presenterHere,
  transcribeHere,
  voicesHere,
  type Core,
} from "./core.js";
import { AppError, ERROR_CODES, type ErrorBody, type HttpStatus } from "./errors.js";
import { apiPath, type ApiMethod } from "./shared/routes.js";

const REQUEST_TIMEOUT_MS = 180_000;

export class RemoteCore implements Core {
  private getCfg: () => FlowConfig;

  constructor(getCfg: () => FlowConfig = getConfig) {
    this.getCfg = getCfg;
  }

  private async call(method: ApiMethod, args: unknown): Promise<unknown> {
    const cfg = this.getCfg();
    const token = readFileSync(cfg.tokenFile, "utf8").trim();
    const res = await fetch(`http://127.0.0.1:${cfg.port}${apiPath(method)}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-flow-token": token },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const data = (await res.json()) as Partial<ErrorBody>;
    if (!res.ok) {
      const status = res.status as HttpStatus;
      const code = data.code ?? ERROR_CODES.INTERNAL_ERROR;
      const message = data.error ?? `flow-mcp owner process answered ${res.status}`;
      throw new AppError(status, code, message, data.meta);
    }
    return data;
  }

  status = (a: unknown) => this.call("status", a);
  generate = (a: unknown) => this.call("generate", a);
  cancel = (a: unknown) => this.call("cancel", a);
  retry = (a: unknown) => this.call("retry", a);
  assets = (a: unknown) => this.call("assets", a);
  download = (a: unknown) => this.call("download", a);
  assemble = (a: unknown) => this.call("assemble", a);
  techniques = (a: unknown) => this.call("techniques", a);
  voices = voicesHere;
  narrate = narrateHere;
  new_project = (a: unknown) => this.call("new_project", a);
  character = (a: unknown) => this.call("character", a);
  characters = () => this.call("characters", {});
  cast = () => this.call("cast", {});
  character_edit = (a: unknown) => this.call("character_edit", a);
  edit = (a: unknown) => this.call("edit", a);
  trash = (a: unknown) => this.call("trash", a);
  discard = (a: unknown) => this.call("discard", a);
  set_key = (a: unknown) => this.call("set_key", a);
  continue_shot = (a: unknown) => this.call("continue_shot", a);
  agent = (a: unknown) => this.call("agent", a);
  outputs = () => this.call("outputs", {});
  transcribe = transcribeHere;
  caption_preview = captionPreviewHere;
  captions = captionsHere;
  presenter = presenterHere;
  caption_setup = captionSetupHere;

  accounts = () => this.call("accounts", {});
  account_add = (a: unknown) => this.call("account_add", a);
  account_switch = (a: unknown) => this.call("account_switch", a);
  account_login = (a: unknown) => this.call("account_login", a);
  account_rename = (a: unknown) => this.call("account_rename", a);
  account_enable = (a: unknown) => this.call("account_enable", a);
  account_reorder = (a: unknown) => this.call("account_reorder", a);
  account_remove = (a: unknown) => this.call("account_remove", a);
  account_refresh = (a: unknown) => this.call("account_refresh", a);
  account_config = (a: unknown) => this.call("account_config", a);

  async wait(a: { job_ids?: string[]; timeout_seconds: number }): Promise<unknown> {
    const deadline = Date.now() + a.timeout_seconds * 1000;
    for (;;) {
      const left = Math.ceil((deadline - Date.now()) / 1000);
      const out = (await this.call("wait", { ...a, timeout_seconds: Math.max(5, Math.min(120, left)) })) as { finished: boolean };
      if (out.finished || left <= 120) return out;
    }
  }
}
