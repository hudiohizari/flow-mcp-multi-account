import { randomBytes } from "node:crypto";
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ensurePrivateDir } from "./account-paths.js";
import { getConfig, type FlowConfig } from "./config.js";
import type { Core } from "./core.js";
import { AppError, ERROR_CODES, toErrorPayload } from "./errors.js";
import { t } from "./i18n.js";
import { shapes } from "./schemas.js";
import { API_METHOD_SET, STATIC_ROUTES } from "./shared/routes.js";

const PKG_ROOT = new URL("../", import.meta.url);
const STUDIO_HTML = fileURLToPath(new URL("studio/index.html", PKG_ROOT));
const LOCALE_EN_FILE = fileURLToPath(new URL("src/locales/en.json", PKG_ROOT));
const DIST_STUDIO_DIR = fileURLToPath(new URL("dist/studio", PKG_ROOT));
const DIST_SHARED_DIR = fileURLToPath(new URL("dist/shared", PKG_ROOT));
const MAX_UPLOAD = 200 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
};

const json = (res: ServerResponse, status: number, data: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
};

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > limit) {
        failed = true;
        fail(new AppError(400, ERROR_CODES.VALIDATION_ERROR, t("error.BODY_TOO_LARGE")));
      } else {
        chunks.push(c);
      }
    });
    req.on("end", () => {
      if (!failed) ok(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (!failed) fail(err);
    });
  });
}

function isInsideReal(realFile: string, dir: string): boolean {
  if (!existsSync(dir)) return false;
  const realDir = realpathSync(dir);
  return realFile.startsWith(realDir + sep);
}

function sendStaticJs(res: ServerResponse, baseDir: string, fileName: string): void {
  const filePath = join(baseDir, `${fileName}.js`);
  if (!existsSync(filePath)) {
    json(res, 404, { error: t("error.NOT_FOUND"), code: ERROR_CODES.NOT_FOUND });
    return;
  }
  res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" });
  res.end(readFileSync(filePath, "utf8"));
}

function sendMedia(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  cfg: FlowConfig,
  getCastDir?: () => string,
): void {
  if (!file || !existsSync(file)) {
    json(res, 404, { error: t("error.MEDIA_NOT_FOUND"), code: ERROR_CODES.MEDIA_NOT_FOUND });
    return;
  }
  const realFile = realpathSync(file);
  const allowDirs = [cfg.outputRoot, cfg.uploadDir, cfg.captionsDir];
  if (getCastDir) allowDirs.push(getCastDir());
  if (!allowDirs.some((dir) => isInsideReal(realFile, dir))) {
    json(res, 403, { error: t("error.PATH_OUTSIDE_ALLOWLIST"), code: ERROR_CODES.PATH_OUTSIDE_ALLOWLIST });
    return;
  }
  const { size } = statSync(realFile);
  const type = MIME[extname(realFile).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, {
      "content-type": type,
      "accept-ranges": "bytes",
      "content-range": `bytes ${start}-${end}/${size}`,
      "content-length": end - start + 1,
    });
    createReadStream(realFile, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size });
  createReadStream(realFile).pipe(res);
}

export type ServerRole = "owner" | "client" | "none";

export interface ServerOptions {
  getConfig?: () => FlowConfig;
  getCastDir?: () => string;
  getRegistryError?: () => string | null;
  probeDelayMs?: number;
  maxUploadBytes?: number;
  localeFile?: string;
  studioDir?: string;
  sharedDir?: string;
}

export interface ServerHandle {
  role: ServerRole;
  port: number;
  close: () => Promise<void>;
}

export async function startOwnerServer(core: Core, opts: ServerOptions = {}): Promise<ServerHandle> {
  const cfg = (opts.getConfig ?? getConfig)();
  mkdirSync(cfg.uploadDir, { recursive: true });
  const token = randomBytes(24).toString("hex");
  const allowedHosts = new Set([`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`]);

  const localeFile = opts.localeFile ?? LOCALE_EN_FILE;
  const studioDir = opts.studioDir ?? DIST_STUDIO_DIR;
  const sharedDir = opts.sharedDir ?? DIST_SHARED_DIR;

  const server = createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host ?? "")) {
        return json(res, 403, { error: t("error.FORBIDDEN_HOST"), code: ERROR_CODES.FORBIDDEN_HOST });
      }
      const url = new URL(req.url!, `http://${req.headers.host}`);

      if (req.method === "GET" && url.pathname === STATIC_ROUTES.HEALTH) {
        const registryError = opts.getRegistryError?.();
        return json(res, 200, { name: "flow-mcp", ...(registryError ? { registryError } : {}) });
      }
      if (url.pathname === STATIC_ROUTES.FAVICON) return void res.writeHead(204).end();
      if (req.method === "GET" && url.pathname === STATIC_ROUTES.HOME) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(readFileSync(STUDIO_HTML, "utf8").replace("__FLOW_TOKEN__", token));
      }
      if (req.method === "GET" && url.pathname === STATIC_ROUTES.LOCALE_EN) {
        if (!existsSync(localeFile)) {
          return json(res, 404, { error: t("error.NOT_FOUND"), code: ERROR_CODES.NOT_FOUND });
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        return res.end(readFileSync(localeFile, "utf8"));
      }
      const studioMatch = req.method === "GET" ? url.pathname.match(/^\/studio\/([a-z0-9-]+)\.js$/) : null;
      if (studioMatch) return sendStaticJs(res, studioDir, studioMatch[1]);
      const sharedMatch = req.method === "GET" ? url.pathname.match(/^\/shared\/([a-z0-9-]+)\.js$/) : null;
      if (sharedMatch) return sendStaticJs(res, sharedDir, sharedMatch[1]);

      const given = req.headers["x-flow-token"] ?? url.searchParams.get("token");
      if (given !== token) return json(res, 401, { error: t("error.UNAUTHORIZED"), code: ERROR_CODES.UNAUTHORIZED });

      if (req.method === "GET" && url.pathname === STATIC_ROUTES.MEDIA) {
        return sendMedia(req, res, url.searchParams.get("path") ?? "", cfg, opts.getCastDir);
      }

      if (req.method === "POST" && url.pathname === STATIC_ROUTES.UPLOAD) {
        const name = basename(url.searchParams.get("name") ?? "upload").replace(/[^\w.-]+/g, "_");
        const path = join(cfg.uploadDir, `${randomBytes(4).toString("hex")}-${name}`);
        writeFileSync(path, await readBody(req, opts.maxUploadBytes ?? MAX_UPLOAD));
        return json(res, 200, { path });
      }

      const method = url.pathname.match(/^\/api\/(\w+)$/)?.[1];
      if (req.method === "POST" && method && API_METHOD_SET.has(method)) {
        const fn = (core as unknown as Record<string, (a: unknown) => Promise<unknown>>)[method];
        const raw = (await readBody(req, 1024 * 1024)).toString() || "{}";
        const shape = (shapes as Record<string, z.ZodRawShape>)[method];
        const args = z.object(shape).parse(JSON.parse(raw));
        return json(res, 200, await fn.call(core, args));
      }
      json(res, 404, { error: t("error.NOT_FOUND"), code: ERROR_CODES.NOT_FOUND });
    } catch (err) {
      const { status, body } = toErrorPayload(err);
      json(res, status, body);
    }
  });

  const listening = await new Promise<boolean>((ok) => {
    server.once("error", () => ok(false));
    server.listen(cfg.port, "127.0.0.1", () => ok(true));
  });

  const close = () =>
    new Promise<void>((resolveClose) => {
      if (!listening) return resolveClose();
      server.close(() => resolveClose());
    });

  const probeDelay = opts.probeDelayMs ?? 1500;
  if (listening) {
    ensurePrivateDir(cfg.homeDir);
    writeFileSync(cfg.tokenFile, token, { mode: 0o600 });
    chmodSync(cfg.tokenFile, 0o600);
    return { role: "owner", port: cfg.port, close };
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    const other = (await fetch(`http://127.0.0.1:${cfg.port}${STATIC_ROUTES.HEALTH}`, {
      signal: AbortSignal.timeout(3000),
    }).then(
      (r) => r.json(),
      () => null,
    )) as { name?: string } | null;
    if (other?.name === "flow-mcp") return { role: "client", port: cfg.port, close };
    if (other) return { role: "none", port: cfg.port, close };
    await new Promise((r) => setTimeout(r, probeDelay));
  }
  return { role: "client", port: cfg.port, close };
}

export async function startServer(core: Core, opts: ServerOptions = {}): Promise<ServerRole> {
  return (await startOwnerServer(core, opts)).role;
}
