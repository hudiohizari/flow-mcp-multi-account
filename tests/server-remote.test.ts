import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getConfig } from "../dist/config.js";
import type { Core } from "../dist/core.js";
import { AppError, ERROR_CODES } from "../dist/errors.js";
import { RemoteCore } from "../dist/remote.js";
import { startOwnerServer, startServer } from "../dist/server.js";

function freePort(): Promise<number> {
  return new Promise((ok) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });
}

function makeStubCore(overrides: Partial<Core> = {}): Core {
  const ok = async () => ({ ok: true });
  return {
    status: ok,
    generate: ok,
    wait: async () => ({ finished: true }),
    cancel: ok,
    retry: ok,
    assets: ok,
    download: ok,
    assemble: ok,
    techniques: ok,
    voices: ok,
    narrate: ok,
    new_project: ok,
    character: ok,
    characters: ok,
    cast: ok,
    character_edit: ok,
    edit: ok,
    trash: ok,
    discard: ok,
    set_key: ok,
    continue_shot: ok,
    agent: ok,
    outputs: ok,
    transcribe: ok,
    caption_preview: ok,
    captions: ok,
    presenter: ok,
    caption_setup: ok,
    accounts: ok,
    account_add: ok,
    account_switch: ok,
    account_login: ok,
    account_rename: ok,
    account_enable: ok,
    account_reorder: ok,
    account_remove: ok,
    account_refresh: ok,
    account_config: ok,
    ...overrides,
  };
}

test("server serves pre-token static assets, enforces host/token/media allowlist, and maps errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-srv-"));
  const port = await freePort();
  try {
    const cfg = getConfig({
      FLOW_MCP_HOME: join(root, "home"),
      FLOW_MCP_OUTPUT: join(root, "out"),
      FLOW_MCP_PORT: String(port),
    });
    const studioDir = join(root, "dist-studio");
    const sharedDir = join(root, "dist-shared");
    const castDir = join(cfg.accountsDir, "b1", "_cast");
    mkdirSync(cfg.outputRoot, { recursive: true });
    mkdirSync(cfg.captionsDir, { recursive: true });
    mkdirSync(studioDir, { recursive: true });
    mkdirSync(sharedDir, { recursive: true });
    mkdirSync(castDir, { recursive: true });
    writeFileSync(join(studioDir, "account-ui.js"), "export const ui = 1;");
    writeFileSync(join(sharedDir, "account-validation.js"), "export const v = 1;");
    writeFileSync(join(cfg.outputRoot, "clip.bin"), "0123456789");
    writeFileSync(join(castDir, "hero.png"), "PNGDATA");
    const outsideFile = join(root, "secret.txt");
    writeFileSync(outsideFile, "secret");

    let regErr: string | null = "corrupt registry";
    const core = makeStubCore({
      account_switch: async () => {
        throw new AppError(409, ERROR_CODES.CHROME_BUSY, "busy");
      },
      account_add: async (a) => ({ added: a.label }),
    });

    const handle = await startOwnerServer(core, {
      getConfig: () => cfg,
      getCastDir: () => castDir,
      getRegistryError: () => regErr,
      studioDir,
      sharedDir,
      maxUploadBytes: 32,
    });
    assert.equal(handle.role, "owner");

    const base = `http://127.0.0.1:${port}`;
    try {
      const token = readFileSync(cfg.tokenFile, "utf8").trim();

      // Bad Host rejected (403)
      const badHostRes = await new Promise<{ status: number; body: string }>((ok, fail) => {
        const req = httpRequest({ host: "127.0.0.1", port, path: "/api/health", headers: { host: "evil.local" } }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => ok({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        });
        req.on("error", fail);
        req.end();
      });
      assert.equal(badHostRes.status, 403);
      assert.equal(JSON.parse(badHostRes.body).code, "FORBIDDEN_HOST");

      // Pre-token static routes + health + favicon + home
      const h1 = await fetch(`${base}/api/health`);
      assert.equal(h1.status, 200);
      assert.equal((await h1.json()).registryError, "corrupt registry");
      regErr = null;
      assert.equal((await (await fetch(`${base}/api/health`)).json()).registryError, undefined);

      assert.equal((await fetch(`${base}/favicon.ico`)).status, 204);
      const html = await (await fetch(`${base}/`)).text();
      assert.ok(html.includes(token));
      assert.equal((await fetch(`${base}/locales/en.json`)).status, 200);
      assert.equal((await fetch(`${base}/studio/account-ui.js`)).status, 200);
      assert.equal((await fetch(`${base}/studio/missing.js`)).status, 404);
      assert.equal((await fetch(`${base}/shared/account-validation.js`)).status, 200);

      // Token gate (401)
      const unauth = await fetch(`${base}/api/accounts`, { method: "POST" });
      assert.equal(unauth.status, 401);

      // Media allowlist + Range requests
      assert.equal((await fetch(`${base}/media?token=${token}`)).status, 404);
      assert.equal((await fetch(`${base}/media?token=${token}&path=${encodeURIComponent(outsideFile)}`)).status, 403);
      assert.equal((await fetch(`${base}/media?token=${token}&path=${encodeURIComponent(join(castDir, "hero.png"))}`)).status, 200);
      const r1 = await fetch(`${base}/media?token=${token}&path=${encodeURIComponent(join(cfg.outputRoot, "clip.bin"))}`, {
        headers: { range: "bytes=2-5" },
      });
      assert.equal(r1.status, 206);
      assert.equal(await r1.text(), "2345");
      const r2 = await fetch(`${base}/media?token=${token}&path=${encodeURIComponent(join(cfg.outputRoot, "clip.bin"))}`, {
        headers: { range: "bytes=-4" },
      });
      assert.equal(r2.status, 206);
      const r3 = await fetch(`${base}/media?token=${token}&path=${encodeURIComponent(join(cfg.outputRoot, "clip.bin"))}`, {
        headers: { range: "bytes=7-" },
      });
      assert.equal(r3.status, 206);

      // Upload + multi-chunk overflow body too large + aborted stream error
      const up = await fetch(`${base}/api/upload`, {
        method: "POST",
        headers: { "x-flow-token": token },
        body: "hello",
      });
      assert.equal(up.status, 200);
      const big = await new Promise<number>((ok, fail) => {
        const req = httpRequest(
          { host: "127.0.0.1", port, method: "POST", path: "/api/upload?name=big.bin", headers: { host: `127.0.0.1:${port}`, "x-flow-token": token } },
          (res) => {
            res.resume();
            res.on("end", () => ok(res.statusCode ?? 0));
          },
        );
        req.on("error", () => {});
        req.write("x".repeat(40));
        setTimeout(() => {
          req.write("y".repeat(20));
          req.end();
        }, 5);
        void fail;
      });
      assert.equal(big, 400);

      // Aborted body request triggers req error handler in readBody
      await new Promise<void>((ok) => {
        const sock = netConnect(port, "127.0.0.1", () => {
          sock.write(`POST /api/accounts HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nx-flow-token: ${token}\r\nContent-Length: 100\r\n\r\npart`);
          setTimeout(() => {
            sock.destroy();
            ok();
          }, 10);
        });
      });
      await new Promise((r) => setTimeout(r, 15));

      // RPC valid, empty body, ZodError, AppError, 404
      assert.equal(
        (await (await fetch(`${base}/api/accounts`, { method: "POST", headers: { "x-flow-token": token } })).json()).ok,
        true,
      );
      assert.equal(
        (await (await fetch(`${base}/api/account_add`, { method: "POST", headers: { "x-flow-token": token }, body: JSON.stringify({ label: "New" }) })).json()).added,
        "New",
      );
      assert.equal(
        (await fetch(`${base}/api/account_add`, { method: "POST", headers: { "x-flow-token": token }, body: "{}" })).status,
        400,
      );
      assert.equal(
        (await fetch(`${base}/api/account_switch`, { method: "POST", headers: { "x-flow-token": token }, body: "{}" })).status,
        409,
      );
      assert.equal(
        (await fetch(`${base}/api/unknown_method`, { method: "POST", headers: { "x-flow-token": token }, body: "{}" })).status,
        404,
      );

      // RemoteCore full parity against running owner
      const remote = new RemoteCore(() => cfg);
      await remote.status({ detailed: false });
      await remote.generate({ project: "p", scenes: [{ prompt: "a", type: "image", max_credits: 0 }] });
      await remote.cancel({ job_id: "1" });
      await remote.retry({});
      await remote.assets({});
      await remote.download({ project: "p", assets: ["a"] });
      await remote.assemble({ project: "p" });
      await remote.techniques({});
      await remote.new_project({});
      await remote.character({ name: "c", describe: "d" });
      await remote.characters();
      await remote.cast();
      await remote.character_edit({ name: "c" });
      await remote.edit({ project: "p", asset: "a", prompt: "b", acknowledge_cost: true });
      await remote.trash({ name: "a" });
      await remote.discard({ path: "/tmp/x" });
      await remote.set_key({ key: "k".repeat(25) });
      await remote.continue_shot({ project: "p", from_asset: "a", prompt: "b", acknowledge_cost: true });
      await remote.agent({ project: "p", scenes: ["a"] });
      await remote.outputs();
      await remote.accounts();
      await remote.account_add({ label: "X" });
      await remote.account_login({});
      await remote.account_rename({ label: "Y" });
      await remote.account_enable({ enabled: true });
      await remote.account_reorder({ ids: ["default"] });
      await remote.account_remove({ id: "x" });
      await remote.account_refresh({});
      await remote.account_config({});
      await remote.account_config({ auto_failover: true });
      await assert.rejects(() => remote.account_switch({ id: "x" }), (err: AppError) => err.status === 409 && err.code === "CHROME_BUSY");

      // RemoteCore wait loop (finished: false then true, and left <= 120)
      let waitCalls = 0;
      const waitStub = makeStubCore({
        wait: async () => (++waitCalls === 1 ? { finished: false } : { finished: true }),
      });
      const wPort = await freePort();
      const wCfg = getConfig({ FLOW_MCP_HOME: join(root, "whome"), FLOW_MCP_OUTPUT: join(root, "wout"), FLOW_MCP_PORT: String(wPort) });
      const wSrv = await startOwnerServer(waitStub, { getConfig: () => wCfg });
      try {
        const wRemote = new RemoteCore(() => wCfg);
        const wOut = (await wRemote.wait({ timeout_seconds: 200 })) as { finished: boolean };
        assert.equal(wOut.finished, true);
        assert.equal(waitCalls, 2);
      } finally {
        await wSrv.close();
      }

      // Sibling startServer detects running owner ("client")
      assert.equal(await startServer(core, { getConfig: () => cfg, probeDelayMs: 1 }), "client");
    } finally {
      await handle.close();
    }

    // Missing locale file returns 404; non-flow-mcp port occupant returns "none"; unresponding port returns "client"
    const p2 = await freePort();
    const cfg2 = getConfig({ FLOW_MCP_HOME: join(root, "h2"), FLOW_MCP_OUTPUT: join(root, "o2"), FLOW_MCP_PORT: String(p2) });
    const srv2 = await startOwnerServer(makeStubCore(), {
      getConfig: () => cfg2,
      localeFile: join(root, "no-locale.json"),
    });
    assert.equal((await fetch(`http://127.0.0.1:${p2}/locales/en.json`)).status, 404);
    await srv2.close();

    // Non-flow-mcp server occupying port -> "none" + close() on non-listening handle
    const otherPort = await freePort();
    const otherSrv = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "other-app" }));
    });
    await new Promise<void>((r) => otherSrv.listen(otherPort, "127.0.0.1", r));
    try {
      const otherCfg = getConfig({ FLOW_MCP_HOME: join(root, "h3"), FLOW_MCP_OUTPUT: join(root, "o3"), FLOW_MCP_PORT: String(otherPort) });
      const otherH = await startOwnerServer(makeStubCore(), { getConfig: () => otherCfg, probeDelayMs: 1 });
      assert.equal(otherH.role, "none");
      await otherH.close();
    } finally {
      await new Promise<void>((r) => otherSrv.close(() => r()));
    }

    // Unresponsive port occupant (closes socket without response) -> falls back to "client" after 8 probes
    const deadPort = await freePort();
    const silentSrv = createServer((req) => req.socket.destroy());
    await new Promise<void>((r) => silentSrv.listen(deadPort, "127.0.0.1", r));
    try {
      const deadCfg = getConfig({ FLOW_MCP_HOME: join(root, "h4"), FLOW_MCP_OUTPUT: join(root, "o4"), FLOW_MCP_PORT: String(deadPort) });
      assert.equal(await startServer(makeStubCore(), { getConfig: () => deadCfg, probeDelayMs: 1 }), "client");
    } finally {
      await new Promise<void>((r) => silentSrv.close(() => r()));
    }

    // RemoteCore fallback when server returns non-JSON error body missing code/error
    const errPort = await freePort();
    const errCfg = getConfig({ FLOW_MCP_HOME: join(root, "h5"), FLOW_MCP_OUTPUT: join(root, "o5"), FLOW_MCP_PORT: String(errPort) });
    mkdirSync(errCfg.homeDir, { recursive: true });
    writeFileSync(errCfg.tokenFile, "t");
    const errSrv = createServer((_req, res) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => errSrv.listen(errPort, "127.0.0.1", r));
    try {
      const errRemote = new RemoteCore(() => errCfg);
      await assert.rejects(() => errRemote.accounts(), (e: AppError) => e.status === 502 && e.code === "INTERNAL_ERROR");
      const rawRemote = new RemoteCore();
      assert.ok(rawRemote);
    } finally {
      await new Promise<void>((r) => errSrv.close(() => r()));
    }

    // Also test missing Host header & default req.url in raw HTTP
    const hRawPort = await freePort();
    const hRawCfg = getConfig({ FLOW_MCP_HOME: join(root, "h6"), FLOW_MCP_OUTPUT: join(root, "o6"), FLOW_MCP_PORT: String(hRawPort) });
    const hRaw = await startOwnerServer(makeStubCore(), { getConfig: () => hRawCfg });
    try {
      const missingHost = await new Promise<string>((ok, fail) => {
        const sock = netConnect(hRawPort, "127.0.0.1", () => {
          sock.write("GET /api/health HTTP/1.0\r\n\r\n");
        });
        let raw = "";
        sock.on("data", (d) => (raw += d.toString()));
        sock.on("end", () => ok(raw));
        sock.on("error", fail);
      });
      assert.match(missingHost, /^HTTP\/1\.1 403 /);
    } finally {
      await hRaw.close();
    }

    // Default startOwnerServer opts + non-existent getCastDir
    const dPort = await freePort();
    const prevPort = process.env.FLOW_MCP_PORT;
    const prevHome = process.env.FLOW_MCP_HOME;
    process.env.FLOW_MCP_PORT = String(dPort);
    process.env.FLOW_MCP_HOME = join(root, "h7");
    const dHandle = await startOwnerServer(makeStubCore(), { getCastDir: () => join(root, "missing-cast-dir") });
    try {
      const tok = readFileSync(join(root, "h7", "token"), "utf8").trim();
      assert.equal((await fetch(`http://127.0.0.1:${dPort}/media?token=${tok}&path=${encodeURIComponent(outsideFile)}`)).status, 403);
      assert.equal((await fetch(`http://127.0.0.1:${dPort}/api/upload`, { method: "POST", headers: { "x-flow-token": tok }, body: "ok" })).status, 200);
    } finally {
      await dHandle.close();
      if (prevPort === undefined) delete process.env.FLOW_MCP_PORT;
      else process.env.FLOW_MCP_PORT = prevPort;
      if (prevHome === undefined) delete process.env.FLOW_MCP_HOME;
      else process.env.FLOW_MCP_HOME = prevHome;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
