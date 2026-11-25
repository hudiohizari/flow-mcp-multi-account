import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { getConfig, type FlowConfig } from "./config.js";
import { AppError, ERROR_CODES } from "./errors.js";
import { t } from "./i18n.js";
import { moveToBin } from "./platform.js";
import { ACCOUNT_CONSTANTS } from "./shared/account-validation.js";

export interface AccountPaths {
  accountRoot: string;
  profileDir: string;
  charactersFile: string;
  collectionsDir: string;
  castDir: string;
  lastProjectUrl?: string;
}

const SAFE_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function resolveAccountPaths(
  account: { slug: string; isDefault: boolean },
  config: FlowConfig = getConfig(),
): AccountPaths {
  if (account.isDefault) {
    return {
      accountRoot: config.homeDir,
      profileDir: join(config.homeDir, "chrome-profile"),
      charactersFile: join(config.homeDir, "characters.json"),
      collectionsDir: join(config.homeDir, "collections"),
      castDir: join(config.outputRoot, "_cast"),
    };
  }
  if (!SAFE_SLUG_RE.test(account.slug) || account.slug === ACCOUNT_CONSTANTS.DEFAULT_SLUG) {
    throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, t("error.UNSAFE_ACCOUNT_PATH"));
  }
  const accountRoot = join(config.accountsDir, account.slug);
  return {
    accountRoot,
    profileDir: join(accountRoot, "chrome-profile"),
    charactersFile: join(accountRoot, "characters.json"),
    collectionsDir: join(accountRoot, "collections"),
    castDir: join(accountRoot, "_cast"),
  };
}

export function ensurePrivateDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  chmodSync(dirPath, 0o700);
}

export function writeFileAtomic(filePath: string, data: string, fileMode = 0o600, privateParent = true): void {
  const parent = dirname(filePath);
  if (privateParent) ensurePrivateDir(parent);
  else mkdirSync(parent, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(tmp, data, { encoding: "utf8", mode: fileMode });
    chmodSync(tmp, fileMode);
    renameSync(tmp, filePath);
  } catch (err) {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
    throw err;
  }
}

export function trashAccountDir(
  accountsDir: string,
  slug: string,
  trashFn: (target: string) => string = moveToBin,
  realpathFn: (p: string) => string = realpathSync,
): string | null {
  if (!slug || !SAFE_SLUG_RE.test(slug) || slug === ACCOUNT_CONSTANTS.DEFAULT_SLUG) {
    throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, t("error.UNSAFE_ACCOUNT_PATH"));
  }
  const target = join(accountsDir, slug);
  let st;
  try {
    st = lstatSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (st.isSymbolicLink()) {
    throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, t("error.UNSAFE_ACCOUNT_PATH"));
  }
  const realRoot = realpathFn(accountsDir);
  const realTarget = realpathFn(target);
  if (!realTarget.startsWith(realRoot + sep)) {
    throw new AppError(400, ERROR_CODES.VALIDATION_ERROR, t("error.UNSAFE_ACCOUNT_PATH"));
  }
  return trashFn(realTarget);
}

let activePathsResolver: () => AccountPaths = () =>
  resolveAccountPaths({ slug: ACCOUNT_CONSTANTS.DEFAULT_SLUG, isDefault: true }, getConfig());

export function setActiveAccountPathsResolver(resolver: () => AccountPaths): void {
  activePathsResolver = resolver;
}

export function getActiveAccountPaths(): AccountPaths {
  return activePathsResolver();
}
