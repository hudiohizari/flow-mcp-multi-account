import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_LOCALE_PATH = fileURLToPath(new URL("../src/locales/en.json", import.meta.url));
let cachedPath: string | null = null;
let cachedMap: Record<string, string> | null = null;

function flattenJson(obj: unknown, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [key, val] of Object.entries(obj)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (typeof val === "string") out[nextKey] = val;
    else flattenJson(val, nextKey, out);
  }
  return out;
}

export function loadLocaleCatalog(localePath = DEFAULT_LOCALE_PATH): Record<string, string> {
  if (cachedMap && cachedPath === localePath) return cachedMap;
  if (!existsSync(localePath)) {
    throw new Error(`Missing locale catalog at ${localePath}`);
  }
  const loaded = flattenJson(JSON.parse(readFileSync(localePath, "utf8")));
  cachedPath = localePath;
  cachedMap = loaded;
  return cachedMap;
}

export function resetLocaleCache(): void {
  cachedPath = null;
  cachedMap = null;
}

export function t(key: string, vars?: Record<string, string | number>, localePath = DEFAULT_LOCALE_PATH): string {
  const catalog = loadLocaleCatalog(localePath);
  let template = catalog[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      template = template.replaceAll(`{{${k}}}`, String(v));
    }
  }
  return template;
}
