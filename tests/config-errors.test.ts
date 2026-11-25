import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import { getConfig, projectDir } from "../dist/config.js";
import { AppError, ERROR_CODES, toErrorPayload } from "../dist/errors.js";
import { loadLocaleCatalog, resetLocaleCache, t } from "../dist/i18n.js";
import { mediaShapes } from "../dist/media-schemas.js";
import { shapes } from "../dist/schemas.js";
import { normalizeAccountLabel, slugifyAccountLabel, validateAccountLabel } from "../dist/shared/account-validation.js";
import { API_METHOD_SET, API_METHODS, apiPath, STATIC_ROUTES } from "../dist/shared/routes.js";

test("config resolves defaults and dynamic env overrides", () => {
  const def = getConfig({});
  assert.equal(def.port, 8787);
  assert.equal(def.cdpPort, 9333);
  assert.equal(def.flowUrl, "https://flow.google.com/");
  assert.equal(def.patienceMs, 45_000);
  assert.equal(def.pauseMinMs, 25_000);
  assert.equal(def.pauseMaxMs, 70_000);
  assert.equal(def.signinUrl, undefined);

  const custom = getConfig({
    FLOW_MCP_HOME: "/tmp/custom-flow-home",
    FLOW_MCP_OUTPUT: "/tmp/custom-flow-out",
    FLOW_MCP_PORT: "9999",
    FLOW_MCP_CDP_PORT: "9444",
    FLOW_MCP_CHROME: " /usr/bin/chrome ",
    FLOW_MCP_FLOW_URL: "http://127.0.0.1:4100/flow/",
    FLOW_MCP_SIGNIN_URL: "http://127.0.0.1:4100/signin",
    FLOW_MCP_PATIENCE_MS: "250",
    FLOW_MCP_PAUSE_MIN_S: "1",
    FLOW_MCP_PAUSE_MAX_S: "2",
    FLOW_MCP_GEMINI_TTS: "gemini-custom",
  });
  assert.equal(custom.homeDir, "/tmp/custom-flow-home");
  assert.equal(custom.outputRoot, "/tmp/custom-flow-out");
  assert.equal(custom.port, 9999);
  assert.equal(custom.cdpPort, 9444);
  assert.equal(custom.chromeBin, "/usr/bin/chrome");
  assert.equal(custom.flowUrl, "http://127.0.0.1:4100/flow/");
  assert.equal(custom.signinUrl, "http://127.0.0.1:4100/signin");
  assert.equal(custom.patienceMs, 250);
  assert.equal(custom.pauseMinMs, 1000);
  assert.equal(custom.pauseMaxMs, 2000);
  assert.equal(custom.geminiTtsModel, "gemini-custom");

  const zeroPause = getConfig({ FLOW_MCP_PAUSE_MIN_S: "0", FLOW_MCP_PAUSE_MAX_S: "0" });
  assert.equal(zeroPause.pauseMinMs, 0);
  assert.equal(zeroPause.pauseMaxMs, 0);

  const invalid = getConfig({ FLOW_MCP_PORT: "0", FLOW_MCP_CDP_PORT: "70000", FLOW_MCP_PATIENCE_MS: "-5", FLOW_MCP_PAUSE_MIN_S: "  ", FLOW_MCP_PAUSE_MAX_S: "-2" });
  assert.equal(invalid.port, 8787);
  assert.equal(invalid.cdpPort, 9333);
  assert.equal(invalid.patienceMs, 45_000);
  assert.equal(invalid.pauseMinMs, 25_000);
  assert.equal(invalid.pauseMaxMs, 70_000);
  assert.equal(projectDir("My Film!", "/tmp/out"), "/tmp/out/My_Film_");
  assert.ok(projectDir("Demo").endsWith("Demo"));
  assert.ok(getConfig().port > 0);
});

test("errors format AppError, ZodError, SyntaxError, TypeError, Error, and unknown", () => {
  const app = toErrorPayload(new AppError(409, ERROR_CODES.CHROME_BUSY, "busy", { active: true }));
  assert.equal(app.status, 409);
  assert.deepEqual(app.body, { error: "busy", code: "CHROME_BUSY", meta: { active: true } });

  const appNoMeta = toErrorPayload(new AppError(404, ERROR_CODES.NOT_FOUND, "missing"));
  assert.equal(appNoMeta.status, 404);
  assert.deepEqual(appNoMeta.body, { error: "missing", code: "NOT_FOUND" });

  let zodErr: unknown;
  try {
    z.object({ label: z.string().min(1) }).parse({ label: "" });
  } catch (e) {
    zodErr = e;
  }
  assert.equal(toErrorPayload(zodErr).status, 400);
  assert.equal(toErrorPayload(zodErr).body.code, "VALIDATION_ERROR");

  const syn = toErrorPayload(new SyntaxError("Bad token"));
  assert.equal(syn.status, 400);
  assert.equal(syn.body.code, "VALIDATION_ERROR");

  const te = toErrorPayload(new TypeError("Null ref"));
  assert.equal(te.status, 500);
  assert.equal(te.body.code, "INTERNAL_ERROR");

  const gen = toErrorPayload(new Error("Domain failure"));
  assert.equal(gen.status, 400);
  assert.equal(gen.body.code, "INVALID_STATE");

  const unk = toErrorPayload("plain string");
  assert.equal(unk.status, 500);
  assert.equal(unk.body.code, "INTERNAL_ERROR");
});

test("i18n loads catalog, caches, interpolates, and validates missing files", () => {
  resetLocaleCache();
  const dir = mkdtempSync(join(tmpdir(), "flow-i18n-"));
  try {
    const customPath = join(dir, "custom.json");
    writeFileSync(customPath, JSON.stringify({ error: { TEST: "Hello {{name}}" }, list: ["ignored"] }), "utf8");
    const first = loadLocaleCatalog(customPath);
    const second = loadLocaleCatalog(customPath);
    assert.equal(first, second);
    assert.equal(t("error.TEST", { name: "World" }, customPath), "Hello World");
    assert.equal(t("missing.key", undefined, customPath), "missing.key");
    assert.throws(() => loadLocaleCatalog(join(dir, "absent.json")), /Missing locale catalog/);
    resetLocaleCache();
    assert.ok(t("error.REGISTRY_CORRUPT").length > 10);
  } finally {
    resetLocaleCache();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shared routes, schemas, and account validation rules", () => {
  assert.equal(STATIC_ROUTES.HEALTH, "/api/health");
  assert.equal(apiPath("account_switch"), "/api/account_switch");
  assert.equal(API_METHOD_SET.has(API_METHODS[0]), true);
  assert.ok(shapes.account_add.label);
  assert.ok(mediaShapes.narrate.text);

  const nfc = normalizeAccountLabel("  Cafe\u0301  ");
  assert.equal(nfc, "Caf\u00e9");

  assert.deepEqual(validateAccountLabel("   ", []), { ok: false, code: "VALIDATION_ERROR", key: "error.LABEL_EMPTY" });
  assert.deepEqual(validateAccountLabel("a".repeat(61), []), {
    ok: false,
    code: "VALIDATION_ERROR",
    key: "error.LABEL_TOO_LONG",
    vars: { max: 60 },
  });
  assert.deepEqual(validateAccountLabel("Bad\u0007Name", []), {
    ok: false,
    code: "VALIDATION_ERROR",
    key: "error.LABEL_CONTROL_CHARS",
  });
  assert.deepEqual(validateAccountLabel(" backup ", ["Backup"]), {
    ok: false,
    code: "DUPLICATE_LABEL",
    key: "error.DUPLICATE_LABEL",
    vars: { label: "backup" },
  });
  assert.deepEqual(validateAccountLabel("  Team Alpha ", ["Backup"]), { ok: true, label: "Team Alpha" });

  assert.equal(slugifyAccountLabel("Default", []), "default-2");
  assert.equal(slugifyAccountLabel("Backup 1", ["backup-1"]), "backup-1-2");
  assert.equal(slugifyAccountLabel("Backup 1", ["backup-1", "backup-1-2"]), "backup-1-3");
  assert.equal(slugifyAccountLabel("!!!", []), "account");
  assert.equal(slugifyAccountLabel("Studio Main", []), "studio-main");
});
