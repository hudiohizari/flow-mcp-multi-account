import { ACCOUNT_CONSTANTS } from "../shared/account-validation.js";
import { getRequiredEl, setFieldValidation } from "./account-dialogs.js";
import { validateAccountLabelInput } from "./account-state.js";
import type { AccountItem, AccountUiEnv, InFlightAccountOp, StudioBridge, Translator } from "./account-types.js";

export interface RowActionsContext {
  env: AccountUiEnv;
  bridge: StudioBridge;
  t: Translator;
  getAccounts: () => AccountItem[];
  setAccounts: (accounts: AccountItem[]) => void;
  getAutoFailover: () => boolean;
  setAutoFailover: (val: boolean) => void;
  setRenaming: (state: { id: string | null; draft: string; touched: boolean; error: string | null }) => void;
  getRenaming: () => { id: string | null; draft: string; touched: boolean; error: string | null };
  closeAddPanel: () => void;
  openNewProject: () => void;
  openTrash: (acc: AccountItem) => void;
  runRowAction: (kind: InFlightAccountOp["kind"], id: string | null, fn: () => Promise<void>) => Promise<void>;
  renderDialog: () => void;
}

export function createRowActionsController(ctx: RowActionsContext) {
  const { env, bridge, t } = ctx;

  const validateRename = (id: string, raw: string, forceShow: boolean): string | null => {
    const others = ctx.getAccounts().filter((a) => a.id !== id).map((a) => a.label);
    const res = validateAccountLabelInput(raw, others, t);
    const countEl = getRequiredEl(env.doc, `accRenameCount-${id}`);
    const errEl = getRequiredEl(env.doc, `accRenameErr-${id}`);
    const inputEl = getRequiredEl(env.doc, `accRenameInput-${id}`);
    countEl.textContent = `${res.length}/${ACCOUNT_CONSTANTS.LABEL_MAX}`;
    const cur = ctx.getRenaming();
    const touched = forceShow ? true : cur.touched;
    const error = touched && !res.ok ? res.message : null;
    ctx.setRenaming({ id: cur.id, draft: raw, touched, error });
    setFieldValidation(inputEl, errEl, `accRenameCount-${id}`, error);
    return res.ok ? res.label : null;
  };

  const switchToAccount = async (id: string): Promise<void> => {
    await ctx.runRowAction("switch", id, async () => {
      const res = await bridge.api<{ alreadyActive?: boolean; account: AccountItem }>("account_switch", { id });
      bridge.toast(t(res.alreadyActive ? "account.toast.alreadyActive" : "account.toast.switched", { label: res.account.label }));
      await bridge.triggerPoll(true);
    });
  };

  const handleFailoverToggle = async (): Promise<void> => {
    await ctx.runRowAction("failoverConfig", null, async () => {
      const next = !ctx.getAutoFailover();
      const res = await bridge.api<{ autoFailover: boolean }>("account_config", { auto_failover: next });
      ctx.setAutoFailover(res.autoFailover);
      bridge.toast(t(res.autoFailover ? "account.failover.toastEnabled" : "account.failover.toastDisabled"));
    });
  };

  const handleRowClick = async (action: string, id: string): Promise<void> => {
    const accounts = ctx.getAccounts();
    const acc = accounts.find((a) => a.id === id);
    if (!acc) return;
    if (action === "rename") {
      ctx.closeAddPanel();
      ctx.setRenaming({ id, draft: acc.label, touched: false, error: null });
      ctx.renderDialog();
      getRequiredEl(env.doc, `accRenameInput-${id}`).focus();
      return;
    }
    if (action === "cancel-rename") {
      ctx.setRenaming({ id: null, draft: "", touched: false, error: null });
      ctx.renderDialog();
      return;
    }
    if (action === "new-project") return ctx.openNewProject();
    if (action === "remove") return ctx.openTrash(acc);
    if (action === "switch") return switchToAccount(id);
    if (action === "login") {
      await ctx.runRowAction("login", id, async () => {
        const res = await bridge.api<{ account: AccountItem }>("account_login", { id });
        bridge.toast(t("account.toast.signInOpened", { label: res.account.label }));
        await bridge.triggerPoll(false);
      });
      return;
    }
    if (action === "refresh") {
      await ctx.runRowAction("refresh", id, async () => {
        const res = await bridge.api<{ busy?: boolean; account: AccountItem }>("account_refresh", { id });
        if (res.busy) bridge.toast(t("error.CHROME_BUSY"), true);
        else bridge.toast(t("account.toast.refreshed", { label: res.account.label }));
        await bridge.triggerPoll(false);
      });
      return;
    }
    if (action === "toggle") {
      await ctx.runRowAction("toggle", id, async () => {
        const nextEnabled = !acc.enabled;
        const res = await bridge.api<{ account: AccountItem; accounts: AccountItem[] }>("account_enable", { id, enabled: nextEnabled });
        ctx.setAccounts(res.accounts);
        bridge.toast(t(nextEnabled ? "account.toast.enabled" : "account.toast.disabled", { label: res.account.label }));
      });
      return;
    }
    const idx = accounts.findIndex((a) => a.id === id);
    const nextIdx = action === "move-up" ? idx - 1 : idx + 1;
    if (nextIdx < 0 || nextIdx >= accounts.length) return;
    const ids = accounts.map((a) => a.id);
    [ids[idx], ids[nextIdx]] = [ids[nextIdx], ids[idx]];
    await ctx.runRowAction("reorder", id, async () => {
      const res = await bridge.api<{ accounts: AccountItem[] }>("account_reorder", { ids });
      ctx.setAccounts(res.accounts);
      bridge.toast(t("account.toast.reordered"));
    });
  };

  const bindListListeners = (accListEl: ReturnType<typeof getRequiredEl>): void => {
    accListEl.addEventListener("input", (e) => {
      const input = e.target.closest("[data-acc-rename-input]");
      if (input) validateRename(input.getAttribute("data-acc-rename-input")!, input.value, false);
    });
    accListEl.addEventListener("focusout", (e) => {
      const input = e.target.closest("[data-acc-rename-input]");
      if (!input) return;
      const cancelHit = e.relatedTarget ? e.relatedTarget.closest('[data-acc-action="cancel-rename"]') : null;
      if (!cancelHit) validateRename(input.getAttribute("data-acc-rename-input")!, input.value, true);
    });
    accListEl.addEventListener("submit", async (e) => {
      const form = e.target.closest("[data-acc-rename-form]");
      if (!form) return;
      e.preventDefault();
      const id = form.getAttribute("data-acc-rename-form")!;
      const input = getRequiredEl(env.doc, `accRenameInput-${id}`);
      const label = validateRename(id, input.value, true);
      if (!label) return input.focus();
      await ctx.runRowAction("rename", id, async () => {
        const res = await bridge.api<{ account: AccountItem; accounts: AccountItem[] }>("account_rename", { id, label });
        ctx.setAccounts(res.accounts);
        ctx.setRenaming({ id: null, draft: "", touched: false, error: null });
        bridge.toast(t("account.toast.renamed", { label: res.account.label }));
        await bridge.triggerPoll(false);
      });
    });
  };

  return { handleRowClick, bindListListeners, handleFailoverToggle, switchToAccount };
}
