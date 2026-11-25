import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface FlowConfig {
  homeDir: string;
  outputRoot: string;
  port: number;
  cdpPort: number;
  cdpUrl: string;
  chromeBin?: string;
  flowUrl: string;
  signinUrl?: string;
  patienceMs: number;
  pauseMinMs: number;
  pauseMaxMs: number;
  geminiTtsModel: string;
  tokenFile: string;
  uploadDir: string;
  downloadsDir: string;
  captionsDir: string;
  modelsDir: string;
  geminiKeyFile: string;
  accountsFile: string;
  accountsDir: string;
}

function parsePort(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback;
}

function parsePositiveMs(raw: string | undefined, fallbackMs: number, scale = 1): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n * scale) : fallbackMs;
}

function parseNonNegativeMs(raw: string | undefined, fallbackMs: number, scale = 1): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallbackMs;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * scale) : fallbackMs;
}

export function getConfig(env: NodeJS.ProcessEnv = process.env): FlowConfig {
  const homeDir = resolve(env.FLOW_MCP_HOME?.trim() || join(homedir(), ".flow-mcp"));
  const outputRoot = resolve(env.FLOW_MCP_OUTPUT?.trim() || join(homedir(), "flow-mcp-out"));
  const port = parsePort(env.FLOW_MCP_PORT, 8787);
  const cdpPort = parsePort(env.FLOW_MCP_CDP_PORT, 9333);
  const chromeBin = env.FLOW_MCP_CHROME?.trim() || undefined;
  const flowUrl = env.FLOW_MCP_FLOW_URL?.trim() || "https://flow.google.com/";
  const signinUrl = env.FLOW_MCP_SIGNIN_URL?.trim() || undefined;
  const patienceMs = parsePositiveMs(env.FLOW_MCP_PATIENCE_MS, 45_000);
  const pauseMinMs = parseNonNegativeMs(env.FLOW_MCP_PAUSE_MIN_S, 25_000, 1000);
  const pauseMaxMs = parseNonNegativeMs(env.FLOW_MCP_PAUSE_MAX_S, 70_000, 1000);
  const geminiTtsModel = env.FLOW_MCP_GEMINI_TTS?.trim() || "gemini-2.5-flash-preview-tts";

  return {
    homeDir,
    outputRoot,
    port,
    cdpPort,
    cdpUrl: `http://127.0.0.1:${cdpPort}`,
    chromeBin,
    flowUrl,
    signinUrl,
    patienceMs,
    pauseMinMs,
    pauseMaxMs,
    geminiTtsModel,
    tokenFile: join(homeDir, "token"),
    uploadDir: join(homeDir, "uploads"),
    downloadsDir: join(homeDir, "downloads"),
    captionsDir: join(homeDir, "captions"),
    modelsDir: join(homeDir, "models"),
    geminiKeyFile: join(homeDir, "gemini-key"),
    accountsFile: join(homeDir, "accounts.json"),
    accountsDir: join(homeDir, "accounts"),
  };
}

export function projectDir(project: string, outputRoot = getConfig().outputRoot): string {
  return resolve(outputRoot, project.replace(/[^\w.-]+/g, "_"));
}
