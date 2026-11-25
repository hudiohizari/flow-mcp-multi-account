import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

export const IS_MAC = process.platform === "darwin";
export const IS_WIN = process.platform === "win32";

export const computerName = (p: NodeJS.Platform = process.platform) =>
  p === "darwin" ? "this Mac" : p === "win32" ? "this PC" : "this computer";
export const binName = (p: NodeJS.Platform = process.platform) =>
  p === "darwin" ? "the Mac's Trash" : p === "win32" ? "the Recycle Bin" : "the Trash";
export const ffmpegHint = (p: NodeJS.Platform = process.platform) =>
  p === "darwin" ? "brew install ffmpeg" : p === "win32" ? "winget install Gyan.FFmpeg" : "sudo apt install ffmpeg";

export const COMPUTER = computerName();
export const BIN = binName();
export const FFMPEG_HINT = ffmpegHint();

export interface PlatformFs {
  platform: NodeJS.Platform;
  home: string;
  now: () => number;
  existsSync: typeof existsSync;
  mkdirSync: typeof mkdirSync;
  renameSync: typeof renameSync;
  cpSync: typeof cpSync;
  rmSync: typeof rmSync;
  statSync: typeof statSync;
  execFileSync: typeof execFileSync;
}

export function defaultPlatformFs(): PlatformFs {
  return {
    platform: process.platform,
    home: homedir(),
    now: () => Date.now(),
    existsSync,
    mkdirSync,
    renameSync,
    cpSync,
    rmSync,
    statSync,
    execFileSync,
  };
}

export const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function powershell(script: string, timeout = 120_000, exec: typeof execFileSync = execFileSync): string {
  return exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    timeout,
    windowsHide: true,
  });
}

function moveWithExdevFallback(src: string, dest: string, io: PlatformFs): void {
  try {
    io.renameSync(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    io.cpSync(src, dest, { recursive: true, force: false, errorOnExist: true });
    io.rmSync(src, { recursive: true, force: true });
  }
}

export function moveToBin(target: string, io: PlatformFs = defaultPlatformFs()): string {
  if (io.platform === "darwin") {
    const bin = join(io.home, ".Trash");
    io.mkdirSync(bin, { recursive: true });
    const name = basename(target);
    const ext = extname(name);
    const dest = io.existsSync(join(bin, name))
      ? join(bin, `${name.slice(0, name.length - ext.length)}-${io.now()}${ext}`)
      : join(bin, name);
    moveWithExdevFallback(target, dest, io);
    return dest;
  }
  if (io.platform === "win32") {
    const kind = io.statSync(target).isDirectory() ? "DeleteDirectory" : "DeleteFile";
    powershell(
      `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${kind}(${psQuote(target)}, 'OnlyErrorDialogs', 'SendToRecycleBin')`,
      120_000,
      io.execFileSync,
    );
    return "the Recycle Bin";
  }
  try {
    io.execFileSync("gio", ["trash", target], { stdio: "ignore" });
    return "the Trash";
  } catch {
    const bin = join(io.home, ".local", "share", "Trash", "files");
    io.mkdirSync(bin, { recursive: true });
    const dest = join(bin, `${basename(target)}-${io.now()}`);
    moveWithExdevFallback(target, dest, io);
    return dest;
  }
}

export function extractZip(zip: string, dest: string, exec: typeof execFileSync = execFileSync): string[] {
  mkdirSync(dest, { recursive: true });
  try {
    exec("tar", ["-xf", zip, "-C", dest], { stdio: "ignore" });
  } catch {
    exec("unzip", ["-o", "-q", zip, "-d", dest], { stdio: "ignore" });
  }
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      if (f.startsWith(".") || f === "__MACOSX") continue;
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(dest);
  return files;
}

export function openUrl(url: string, io: Pick<PlatformFs, "platform" | "execFileSync"> = defaultPlatformFs()): void {
  try {
    if (io.platform === "darwin") io.execFileSync("open", [url], { stdio: "ignore" });
    else if (io.platform === "win32") io.execFileSync("cmd", ["/c", "start", "", url], { stdio: "ignore", windowsHide: true });
    else io.execFileSync("xdg-open", [url], { stdio: "ignore" });
  } catch {
    // Convenience launch; caller also prints URL.
  }
}
