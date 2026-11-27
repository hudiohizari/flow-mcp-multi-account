import type { ApiMethod } from "../shared/routes.js";

export type LocaleCatalog = Record<string, string>;
export type Translator = (key: string, vars?: Record<string, string | number>) => string;

export interface AccountItem {
  id: string;
  slug: string;
  label: string;
  isDefault: boolean;
  enabled: boolean;
  priority: number;
  active: boolean;
  plan?: string;
  creditsRemaining?: number;
  balanceUpdatedAt?: string;
  lastProjectUrl?: string;
  lastProjectTitle?: string;
  exhaustedMinCost?: number;
  exhaustedAt?: string;
  exhausted?: boolean;
  needsRelogin: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface PendingLoginInfo {
  targetAccountId: string;
  previousAccountId: string;
  startedAt: string;
}

interface PendingFailoverInfo {
  originalAccountId: string;
  candidateAccountId: string;
  startedAt: string;
}

type FailoverStage = "evaluating" | "switching" | "verifying" | "reverting";

export interface FailoverPhaseInfo {
  stage: FailoverStage;
  fromAccountId: string;
  fromLabel: string;
  toAccountId?: string;
  toLabel?: string;
  startedAt: string;
}

interface FailoverOrigin {
  accountId: string;
  accountLabel: string;
}

export interface FailoverAttempt {
  accountId: string;
  accountLabel: string;
  status: "skipped" | "failed" | "succeeded";
  code?: string;
  reason: string;
}

export interface FlowStatusInfo {
  url: string;
  connected: boolean;
  signedIn: boolean;
  inProject: boolean;
  authInProgress: boolean;
  plan?: string;
  credits_remaining?: number;
  balanceUpdatedAt?: string;
  hint?: string;
}

export interface StudioJobView {
  id: string;
  status: string;
  accountId?: string;
  accountLabel?: string;
  portable?: boolean;
  failoverFrom?: FailoverOrigin;
  failoverAttempts?: FailoverAttempt[];
  errorCode?: string;
  project?: string;
  scene?: string;
  prompt?: string;
  attempts?: number;
  credits?: number;
  progress?: string;
  files?: string[];
  note?: string;
  error?: string;
  failed_scenes?: number[];
}

export interface StudioStatusPayload {
  flow: FlowStatusInfo;
  activeAccount: AccountItem | null;
  activeAccountId: string | null;
  accounts: AccountItem[];
  pendingLogin: PendingLoginInfo | null;
  pendingFailover?: PendingFailoverInfo | null;
  autoFailover?: boolean;
  failoverPhase?: FailoverPhaseInfo | null;
  registryError: string | null;
  busy: boolean;
  switchInProgress: boolean;
  pacing?: string | null;
  output_root?: string;
  jobs: StudioJobView[];
}

export interface AccountsPayload {
  activeAccountId: string | null;
  pendingLogin: PendingLoginInfo | null;
  pendingFailover?: PendingFailoverInfo | null;
  autoFailover?: boolean;
  registryError: string | null;
  accounts: AccountItem[];
}

export interface AccountActionError {
  message: string;
  code: string | null;
}

export type AccountsViewState =
  | { kind: "loading" }
  | { kind: "error"; message: string; code: string | null; accounts: AccountItem[]; activeAccountId: string | null }
  | {
      kind: "switching";
      accounts: AccountItem[];
      activeAccountId: string;
      targetId: string | null;
      failoverPhase?: FailoverPhaseInfo | null;
    }
  | { kind: "authInProgress"; accounts: AccountItem[]; activeAccount: AccountItem; pendingLogin: PendingLoginInfo | null }
  | { kind: "empty"; accounts: AccountItem[]; activeAccount: AccountItem }
  | { kind: "populated"; accounts: AccountItem[]; activeAccount: AccountItem };

export interface HeaderStatusModel {
  tallyClass: "dim" | "ready" | "rolling" | "down";
  statusText: string;
  plan: string | undefined;
  credits: number | undefined;
  pillText: string;
  pillAria: string;
  pillTitle: string;
  pillTone: "dim" | "ready" | "warn" | "down" | "rolling";
  hintText: string | null;
  showNewProjectBtn: boolean;
  failoverPhase: FailoverPhaseInfo | null;
}

export interface DisabledReason {
  id: string;
  text: string;
}

export interface RowControlState {
  switchDisabled: boolean;
  switchReason: DisabledReason | null;
  enableDisabled: boolean;
  enableReason: DisabledReason | null;
  refreshDisabled: boolean;
  refreshReason: DisabledReason | null;
  newProjectDisabled: boolean;
  newProjectReason: DisabledReason | null;
  moveUpDisabled: boolean;
  moveUpReason: DisabledReason | null;
  moveDownDisabled: boolean;
  moveDownReason: DisabledReason | null;
  removeDisabled: boolean;
  removeReason: DisabledReason | null;
  loginDisabled: boolean;
  renameDisabled: boolean;
}

export interface InFlightAccountOp {
  kind:
    | "add"
    | "switch"
    | "login"
    | "rename"
    | "toggle"
    | "reorder"
    | "remove"
    | "refresh"
    | "newProject"
    | "failoverConfig";
  id: string | null;
}

export type SvgIconName =
  | "user-circle"
  | "plus"
  | "arrow-up"
  | "arrow-down"
  | "refresh"
  | "folder-plus"
  | "log-in"
  | "pencil"
  | "trash"
  | "x"
  | "alert-triangle"
  | "check";

export interface StudioSlotRef {
  asset?: string;
  path?: string;
  name?: string;
  assetAccountId?: string;
  assetAccountLabel?: string;
}

export interface StudioScene {
  prompt?: string;
  chain?: boolean;
  first: StudioSlotRef | null;
  last: StudioSlotRef | null;
  refs: StudioSlotRef[];
}

export interface StudioMutableState {
  tab?: string;
  frames: { engine?: string; scenes: StudioScene[] };
  shots: { scenes: StudioScene[] };
}

interface PlaceInfo {
  computer: string;
  bin: string;
  binShort: string;
  platform: string;
}

export interface StudioBridge {
  api: <T = unknown>(method: ApiMethod, body?: Record<string, unknown>, opts?: { signal?: AbortSignal }) => Promise<T>;
  media: (path: string) => string;
  toast: (msg: string, bad?: boolean) => void;
  guard: () => boolean;
  isLive: () => boolean;
  getPlace: () => PlaceInfo;
  getStudioState: () => StudioMutableState;
  getCastImage: () => StudioSlotRef | null;
  setCastImage: (val: StudioSlotRef | null) => void;
  saveStudioState: () => void;
  renderAll: () => void;
  clearLib: () => void;
  clearAssetPickers: () => void;
  clearCast: () => void;
  reloadCast: (signal: AbortSignal, epoch: number) => Promise<void>;
  setSwitchBusy: (busy: boolean) => void;
  triggerPoll: (detailed: boolean) => Promise<void>;
}

export interface ElementLike {
  id: string;
  hidden: boolean;
  disabled: boolean;
  value: string;
  textContent: string | null;
  innerHTML: string;
  open: boolean;
  closest(selector: string): ElementLike | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  focus(): void;
  addEventListener(type: string, listener: (ev: EventLike) => void): void;
  showModal(): void;
  close(): void;
  getBoundingClientRect?(): { height: number };
}

export interface EventLike {
  target: ElementLike;
  relatedTarget: ElementLike | null;
  preventDefault(): void;
}

export interface DocumentLike {
  getElementById(id: string): ElementLike | null;
  querySelector?(selector: string): ElementLike | null;
  documentElement?: { style: { setProperty(name: string, value: string): void } };
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface AccountUiEnv {
  doc: DocumentLike;
  storage: StorageLike;
  fetchFn: typeof fetch;
  locale: string;
  nowMs: () => number;
}

export interface AccountUiController {
  onStatus(st: StudioStatusPayload, detailed: boolean): void;
  renderOffline(live: boolean): void;
  renderJobs(st: StudioStatusPayload): string;
  isEditingAccountForm(): boolean;
  getAccountEpoch(): number;
  getAccountSignal(): AbortSignal;
  openAccountsDialog(): Promise<void>;
  openNewProjectDialog(): void;
  svgIcon(name: SvgIconName): string;
  stampSlot(slot: StudioSlotRef | null): StudioSlotRef | null;
  getSlotView(slot: StudioSlotRef | null): { mismatched: boolean; badgeText: string | null; clearAria: string };
  renderDraftBanner(surface: "frames" | "shots" | "cast"): string;
  clearMismatchedDrafts(surface: "frames" | "shots" | "cast"): void;
  switchDraftAccount(accountId: string): Promise<void>;
  getRollBlock(): { sourceLabels: string; blockedReason: string } | null;
  getCastBlock(): { sourceLabels: string; blockedReason: string } | null;
  t: Translator;
}
