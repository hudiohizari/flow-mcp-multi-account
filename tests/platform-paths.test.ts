import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getActiveAccountPaths, resolveAccountPaths, setActiveAccountPathsResolver, trashAccountDir, writeFileAtomic } from "../dist/account-paths.js";
import { getConfig } from "../dist/config.js";
import { binName, computerName, defaultPlatformFs, extractZip, ffmpegHint, moveToBin, openUrl, powershell, psQuote, type PlatformFs } from "../dist/platform.js";

test("account paths resolve default vs secondary and enforce atomic writes and safe trash", () => {
  const root = mkdtempSync(join(tmpdir(), "flow-paths-"));
  try {
    const cfg = getConfig({ FLOW_MCP_HOME: join(root, "home"), FLOW_MCP_OUTPUT: join(root, "out") });
    const defPaths = resolveAccountPaths({ slug: "default", isDefault: true }, cfg);
    assert.equal(defPaths.profileDir, join(cfg.homeDir, "chrome-profile"));
    assert.equal(defPaths.castDir, join(cfg.outputRoot, "_cast"));

    const secPaths = resolveAccountPaths({ slug: "backup-1", isDefault: false }, cfg);
    assert.equal(secPaths.profileDir, join(cfg.accountsDir, "backup-1", "chrome-profile"));
    assert.equal(secPaths.castDir, join(cfg.accountsDir, "backup-1", "_cast"));

    assert.throws(() => resolveAccountPaths({ slug: "../escape", isDefault: false }, cfg), /outside/);
    assert.throws(() => resolveAccountPaths({ slug: "default", isDefault: false }, cfg), /outside/);

    const privFile = join(cfg.homeDir, "accounts.json");
    writeFileAtomic(privFile, "{\"ok\":true}", 0o600, true);
    assert.equal(readFileSync(privFile, "utf8"), "{\"ok\":true}");
    assert.equal(statSync(privFile).mode & 0o777, 0o600);
    assert.equal(statSync(cfg.homeDir).mode & 0o777, 0o700);

    const pubFile = join(cfg.outputRoot, "manifest.json");
    writeFileAtomic(pubFile, "[]", 0o644, false);
    assert.equal(readFileSync(pubFile, "utf8"), "[]");

    const collisionDir = join(root, "collision");
    mkdirSync(collisionDir, { recursive: true });
    assert.throws(() => writeFileAtomic(collisionDir, "x"));

    mkdirSync(cfg.accountsDir, { recursive: true });
    assert.equal(trashAccountDir(cfg.accountsDir, "missing-slug"), null);
    assert.throws(() => trashAccountDir(cfg.accountsDir, "default"), /outside/);

    const linkTarget = join(root, "outside");
    mkdirSync(linkTarget, { recursive: true });
    const symlinkPath = join(cfg.accountsDir, "evil");
    symlinkSync(linkTarget, symlinkPath);
    assert.throws(() => trashAccountDir(cfg.accountsDir, "evil"), /outside/);

    const victimDir = join(cfg.accountsDir, "victim");
    mkdirSync(victimDir, { recursive: true });
    const intraSymlink = join(cfg.accountsDir, "evil-intra");
    symlinkSync(victimDir, intraSymlink);
    let trashCalled = false;
    assert.throws(
      () =>
        trashAccountDir(cfg.accountsDir, "evil-intra", () => {
          trashCalled = true;
          return "should-not-trash";
        }),
      /outside/,
    );
    assert.equal(trashCalled, false);
    assert.equal(existsSync(victimDir), true);

    const regFile = join(root, "not-a-dir");
    writeFileSync(regFile, "x");
    assert.throws(() => trashAccountDir(regFile, "sub"));

    const realAcc = join(cfg.accountsDir, "acc-1");
    mkdirSync(join(realAcc, "chrome-profile"), { recursive: true });
    let trashed = "";
    const moved = trashAccountDir(cfg.accountsDir, "acc-1", (p) => {
      trashed = p;
      return join(root, "bin", "acc-1");
    });
    assert.ok(trashed.endsWith("acc-1"));
    assert.ok(moved?.includes("bin"));

    const customRoot = join(root, "custom-accounts");
    mkdirSync(customRoot, { recursive: true });
    const fakeAcc = join(customRoot, "acc-2");
    mkdirSync(fakeAcc, { recursive: true });
    assert.throws(() => trashAccountDir(join(customRoot, "sub"), "../acc-2"), /outside/);

    const activeBefore = getActiveAccountPaths();
    assert.ok(activeBefore.profileDir.length > 0);
    setActiveAccountPathsResolver(() => secPaths);
    assert.equal(getActiveAccountPaths().profileDir, secPaths.profileDir);
    setActiveAccountPathsResolver(() => resolveAccountPaths({ slug: "default", isDefault: true }, getConfig()));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trashAccountDir rejects realpath escape outside accountsDir", () => {
  const root = mkdtempSync(join(tmpdir(), "flow-escape-"));
  try {
    const accountsRoot = join(root, "accounts");
    const itemDir = join(accountsRoot, "item");
    mkdirSync(itemDir, { recursive: true });
    assert.throws(
      () =>
        trashAccountDir(
          accountsRoot,
          "item",
          (p) => p,
          (p) => (p === itemDir ? join(root, "outside", "item") : accountsRoot),
        ),
      /outside/,
    );
    assert.equal(computerName("darwin"), "this Mac");
    assert.equal(computerName("win32"), "this PC");
    assert.equal(computerName("linux"), "this computer");
    assert.equal(binName("darwin"), "the Mac's Trash");
    assert.equal(binName("win32"), "the Recycle Bin");
    assert.equal(binName("linux"), "the Trash");
    assert.equal(ffmpegHint("darwin"), "brew install ffmpeg");
    assert.equal(ffmpegHint("win32"), "winget install Gyan.FFmpeg");
    assert.equal(ffmpegHint("linux"), "sudo apt install ffmpeg");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("platform helpers handle EXDEV fallback, macOS collisions, Linux, Windows, zip, and openUrl", () => {
  const root = mkdtempSync(join(tmpdir(), "flow-plat-"));
  try {
    const realDefaults = defaultPlatformFs();
    assert.ok(realDefaults.home.length > 0);
    assert.ok(realDefaults.now() > 0);
    assert.equal(psQuote("a'b"), "'a''b'");

    const macHome = join(root, "mac-home");
    const src1 = join(root, "folder-a");
    mkdirSync(src1, { recursive: true });
    writeFileSync(join(src1, "a.txt"), "1");
    const macIo: PlatformFs = {
      ...realDefaults,
      platform: "darwin",
      home: macHome,
      now: () => 42,
    };
    const dest1 = moveToBin(src1, macIo);
    assert.equal(dest1, join(macHome, ".Trash", "folder-a"));
    assert.equal(existsSync(src1), false);

    const src2 = join(root, "folder-a");
    mkdirSync(src2, { recursive: true });
    const dest2 = moveToBin(src2, macIo);
    assert.equal(dest2, join(macHome, ".Trash", "folder-a-42"));

    const srcExdev = join(root, "exdev-dir");
    mkdirSync(srcExdev, { recursive: true });
    writeFileSync(join(srcExdev, "b.txt"), "2");
    const exdevIo: PlatformFs = {
      ...macIo,
      renameSync: (() => {
        const err = new Error("EXDEV") as NodeJS.ErrnoException;
        err.code = "EXDEV";
        throw err;
      }) as typeof renameSync,
      cpSync,
      rmSync,
    };
    const destExdev = moveToBin(srcExdev, exdevIo);
    assert.equal(existsSync(join(destExdev, "b.txt")), true);
    assert.equal(existsSync(srcExdev), false);

    const nonExdevIo: PlatformFs = {
      ...macIo,
      renameSync: (() => {
        throw new Error("EACCES");
      }) as typeof renameSync,
    };
    const srcFail = join(root, "fail-dir");
    mkdirSync(srcFail, { recursive: true });
    assert.throws(() => moveToBin(srcFail, nonExdevIo), /EACCES/);

    const winLogs: string[] = [];
    const winFile = join(root, "clip.mp4");
    writeFileSync(winFile, "x");
    const winIo: PlatformFs = {
      ...realDefaults,
      platform: "win32",
      execFileSync: ((cmd: string, args: string[]) => {
        winLogs.push(`${cmd}:${args.join(" ")}`);
        return "";
      }) as unknown as typeof realDefaults.execFileSync,
    };
    assert.equal(moveToBin(winFile, winIo), "the Recycle Bin");
    assert.equal(moveToBin(root, winIo), "the Recycle Bin");
    assert.match(winLogs[0], /DeleteFile/);
    assert.match(winLogs[1], /DeleteDirectory/);

    const linHome = join(root, "lin-home");
    const linFile = join(root, "lin-a");
    writeFileSync(linFile, "x");
    const linGioOk: PlatformFs = {
      ...realDefaults,
      platform: "linux",
      home: linHome,
      execFileSync: (() => "") as unknown as typeof realDefaults.execFileSync,
    };
    assert.equal(moveToBin(linFile, linGioOk), "the Trash");

    const linGioFail: PlatformFs = {
      ...linGioOk,
      now: () => 99,
      execFileSync: (() => {
        throw new Error("no gio");
      }) as unknown as typeof realDefaults.execFileSync,
    };
    const linFallbackDest = moveToBin(linFile, linGioFail);
    assert.equal(linFallbackDest, join(linHome, ".local", "share", "Trash", "files", "lin-a-99"));

    const zipOut = join(root, "unzipped");
    const zipSrc = join(root, "zipsrc");
    mkdirSync(join(zipSrc, "sub"), { recursive: true });
    writeFileSync(join(zipSrc, ".hidden"), "skip");
    writeFileSync(join(zipSrc, "sub", "f.txt"), "ok");
    let tarFailed = false;
    const extracted = extractZip("dummy.zip", zipOut, ((cmd: string) => {
      if (cmd === "tar") {
        tarFailed = true;
        throw new Error("no tar");
      }
      cpSync(zipSrc, zipOut, { recursive: true });
      return "";
    }) as unknown as typeof realDefaults.execFileSync);
    assert.equal(tarFailed, true);
    assert.deepEqual(extracted, [join(zipOut, "sub", "f.txt")]);

    const extractedTar = extractZip("dummy.zip", join(root, "tarout"), (() => "") as unknown as typeof realDefaults.execFileSync);
    assert.deepEqual(extractedTar, []);

    const opened: string[] = [];
    openUrl("https://example.com", {
      platform: "darwin",
      execFileSync: ((c: string) => {
        opened.push(c);
        return "";
      }) as unknown as typeof realDefaults.execFileSync,
    });
    openUrl("https://example.com", {
      platform: "win32",
      execFileSync: ((c: string) => {
        opened.push(c);
        return "";
      }) as unknown as typeof realDefaults.execFileSync,
    });
    openUrl("https://example.com", {
      platform: "linux",
      execFileSync: ((c: string) => {
        opened.push(c);
        throw new Error("no xdg");
      }) as unknown as typeof realDefaults.execFileSync,
    });
    assert.deepEqual(opened, ["open", "cmd", "xdg-open"]);
    assert.equal(powershell("Write-Output 1", 1000, (() => "ok") as unknown as typeof realDefaults.execFileSync), "ok");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
