import { ACCOUNT_CONSTANTS } from "../shared/account-validation.js";
import { esc, renderTrashDialogContent, svgIcon } from "./account-render.js";
import { extractErrorInfo, validateAccountLabelInput } from "./account-state.js";
import type { AccountItem, AccountUiEnv, ElementLike, StudioBridge, Translator } from "./account-types.js";

export function getRequiredEl(doc: AccountUiEnv["doc"], id: string): ElementLike {
  const el = doc.getElementById(id);
  if (!el) throw new Error(`Missing Studio element #${id}`);
  return el;
}

export function setFieldValidation(
  input: ElementLike,
  errEl: ElementLike,
  baseDescribedBy: string,
  errorMsg: string | null,
): void {
  if (errorMsg) {
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", `${baseDescribedBy} ${errEl.id}`);
    errEl.hidden = false;
    errEl.innerHTML = `${svgIcon("alert-triangle")}<span>${esc(errorMsg)}</span>`;
    return;
  }
  input.setAttribute("aria-invalid", "false");
  input.setAttribute("aria-describedby", baseDescribedBy);
  errEl.hidden = true;
  errEl.innerHTML = "";
}

export function bindAddAccountForm(opts: {
  env: AccountUiEnv;
  bridge: StudioBridge;
  t: Translator;
  getAccounts: () => AccountItem[];
  onOpenChange: (open: boolean) => void;
  onAdded: (accounts: AccountItem[]) => Promise<void>;
}): { setOpen: (open: boolean) => void; isOpen: () => boolean } {
  const { env, bridge, t, getAccounts, onOpenChange, onAdded } = opts;
  const accAddToggleBtn = getRequiredEl(env.doc, "accAddToggle");
  const accAddPanel = getRequiredEl(env.doc, "accAddPanel");
  const accAddForm = getRequiredEl(env.doc, "accAddForm");
  const accAddInput = getRequiredEl(env.doc, "accAddInput");
  const accAddCount = getRequiredEl(env.doc, "accAddCount");
  const accAddError = getRequiredEl(env.doc, "accAddError");
  const accAddSubmit = getRequiredEl(env.doc, "accAddSubmit");
  const accAddCancel = getRequiredEl(env.doc, "accAddCancel");

  accAddToggleBtn.innerHTML = `${svgIcon("plus")}<span>${esc(t("account.actions.addAccount"))}</span>`;
  getRequiredEl(env.doc, "accAddHeading").textContent = t("account.form.addHeading");
  getRequiredEl(env.doc, "accAddLabel").textContent = t("account.form.addLabel");
  accAddInput.setAttribute("placeholder", t("account.form.addPlaceholder"));
  getRequiredEl(env.doc, "accAddHelper").textContent = t("account.form.addHelper");
  accAddSubmit.textContent = t("account.actions.addAccount");
  accAddCancel.textContent = t("account.actions.cancel");

  let open = false;
  let touched = false;

  const validate = (forceShow: boolean): string | null => {
    const res = validateAccountLabelInput(accAddInput.value, getAccounts().map((a) => a.label), t);
    accAddCount.textContent = `${res.length}/${ACCOUNT_CONSTANTS.LABEL_MAX}`;
    if (forceShow) touched = true;
    if (!touched) {
      setFieldValidation(accAddInput, accAddError, "accAddHelper accAddCount", null);
      return null;
    }
    if (!res.ok) {
      setFieldValidation(accAddInput, accAddError, "accAddHelper accAddCount", res.message);
      return null;
    }
    setFieldValidation(accAddInput, accAddError, "accAddHelper accAddCount", null);
    return res.label;
  };

  const setOpen = (next: boolean): void => {
    open = next;
    touched = false;
    accAddPanel.hidden = !next;
    accAddToggleBtn.setAttribute("aria-expanded", String(next));
    accAddInput.value = "";
    accAddCount.textContent = `0/${ACCOUNT_CONSTANTS.LABEL_MAX}`;
    setFieldValidation(accAddInput, accAddError, "accAddHelper accAddCount", null);
    onOpenChange(next);
    if (next) accAddInput.focus();
  };

  accAddToggleBtn.addEventListener("click", () => setOpen(!open));
  accAddCancel.addEventListener("click", () => setOpen(false));
  accAddInput.addEventListener("input", () => validate(false));
  accAddInput.addEventListener("blur", () => {
    if (accAddInput.value.length > 0) validate(true);
  });

  accAddForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const label = validate(true);
    if (!label) {
      accAddInput.focus();
      return;
    }
    if (accAddSubmit.disabled || !bridge.guard()) return;
    accAddSubmit.disabled = true;
    accAddSubmit.setAttribute("aria-busy", "true");
    accAddSubmit.textContent = t("account.actions.adding");
    try {
      const res = await bridge.api<{ account: AccountItem; accounts: AccountItem[] }>("account_add", { label });
      setOpen(false);
      bridge.toast(t("account.toast.added", { label: res.account.label }));
      await onAdded(res.accounts);
    } catch (err) {
      const info = extractErrorInfo(err, t);
      touched = true;
      setFieldValidation(accAddInput, accAddError, "accAddHelper accAddCount", info.message);
      accAddInput.focus();
      bridge.toast(info.message, true);
    } finally {
      accAddSubmit.disabled = false;
      accAddSubmit.removeAttribute("aria-busy");
      accAddSubmit.textContent = t("account.actions.addAccount");
    }
  });

  return { setOpen, isOpen: () => open };
}

export function bindTrashDialog(opts: {
  env: AccountUiEnv;
  bridge: StudioBridge;
  t: Translator;
  onRemoved: (accounts: AccountItem[]) => Promise<void>;
  onError: (err: { message: string; code: string | null }) => void;
}): { open: (account: AccountItem) => void } {
  const { env, bridge, t, onRemoved, onError } = opts;
  const dialog = getRequiredEl(env.doc, "accountTrashDialog");
  const bodyEl = getRequiredEl(env.doc, "accTrashBody");
  let targetAccount: AccountItem | null = null;

  dialog.addEventListener("click", async (e) => {
    if (e.target.closest("[data-trash-cancel]")) {
      targetAccount = null;
      dialog.close();
      return;
    }
    if (!e.target.closest("[data-trash-confirm]") || !targetAccount) return;
    const acc = targetAccount;
    targetAccount = null;
    const binName = bridge.getPlace().bin;
    bodyEl.innerHTML = renderTrashDialogContent(acc, binName, true, t);
    try {
      const res = await bridge.api<{ accounts: AccountItem[] }>("account_remove", { id: acc.id });
      dialog.close();
      bridge.toast(t("account.toast.removed", { label: acc.label, binName }));
      await onRemoved(res.accounts);
    } catch (err) {
      const info = extractErrorInfo(err, t);
      dialog.close();
      onError(info);
      bridge.toast(info.message, true);
    }
  });

  return {
    open: (account: AccountItem) => {
      targetAccount = account;
      bodyEl.innerHTML = renderTrashDialogContent(account, bridge.getPlace().bin, false, t);
      dialog.showModal();
    },
  };
}

export function bindNewProjectDialog(opts: {
  env: AccountUiEnv;
  bridge: StudioBridge;
  t: Translator;
}): { open: () => void } {
  const { env, bridge, t } = opts;
  const dialog = getRequiredEl(env.doc, "newProjectDialog");
  const form = getRequiredEl(env.doc, "newProjForm");
  const input = getRequiredEl(env.doc, "newProjTitleInput");
  const confirmBtn = getRequiredEl(env.doc, "newProjConfirm");
  const cancelBtn = getRequiredEl(env.doc, "newProjCancel");

  getRequiredEl(env.doc, "newProjTitle").textContent = t("account.newProject.title");
  getRequiredEl(env.doc, "newProjDesc").textContent = t("account.newProject.description");
  getRequiredEl(env.doc, "newProjLabel").textContent = t("account.newProject.fieldLabel");
  input.setAttribute("placeholder", t("account.newProject.placeholder"));
  confirmBtn.textContent = t("account.newProject.confirm");
  cancelBtn.textContent = t("account.newProject.cancel");

  cancelBtn.addEventListener("click", () => dialog.close());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (confirmBtn.disabled || !bridge.guard()) return;
    const title = input.value.trim();
    confirmBtn.disabled = true;
    confirmBtn.setAttribute("aria-busy", "true");
    confirmBtn.textContent = t("account.actions.creatingProject");
    try {
      const made = await bridge.api<{ title?: string }>("new_project", title ? { title } : {});
      dialog.close();
      bridge.toast(
        made.title
          ? t("account.newProject.success", { title: made.title })
          : t("account.newProject.successUntitled"),
      );
      await bridge.triggerPoll(true);
    } catch (err) {
      bridge.toast(extractErrorInfo(err, t).message, true);
    } finally {
      confirmBtn.disabled = false;
      confirmBtn.removeAttribute("aria-busy");
      confirmBtn.textContent = t("account.newProject.confirm");
    }
  });

  return {
    open: () => {
      input.value = "";
      confirmBtn.disabled = false;
      confirmBtn.textContent = t("account.newProject.confirm");
      dialog.showModal();
      input.focus();
    },
  };
}
