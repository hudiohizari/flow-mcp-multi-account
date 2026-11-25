export const ACCOUNT_CONSTANTS = {
  DEFAULT_ID: "default",
  DEFAULT_SLUG: "default",
  DEFAULT_LABEL: "Primary",
  LABEL_MIN: 1,
  LABEL_MAX: 60,
  SLUG_MAX: 36,
} as const;

export type LabelValidationResult =
  | { ok: true; label: string }
  | { ok: false; code: "VALIDATION_ERROR" | "DUPLICATE_LABEL"; key: string; vars?: Record<string, string | number> };

export function normalizeAccountLabel(raw: string): string {
  return raw.normalize("NFC").trim();
}

export function validateAccountLabel(raw: string, existingLabels: Iterable<string>): LabelValidationResult {
  const label = normalizeAccountLabel(raw);
  if (label.length < ACCOUNT_CONSTANTS.LABEL_MIN) {
    return { ok: false, code: "VALIDATION_ERROR", key: "error.LABEL_EMPTY" };
  }
  if (label.length > ACCOUNT_CONSTANTS.LABEL_MAX) {
    return { ok: false, code: "VALIDATION_ERROR", key: "error.LABEL_TOO_LONG", vars: { max: ACCOUNT_CONSTANTS.LABEL_MAX } };
  }
  if (/[\u0000-\u001F\u007F]/.test(label)) {
    return { ok: false, code: "VALIDATION_ERROR", key: "error.LABEL_CONTROL_CHARS" };
  }
  const needle = label.toLowerCase();
  for (const existing of existingLabels) {
    if (normalizeAccountLabel(existing).toLowerCase() === needle) {
      return { ok: false, code: "DUPLICATE_LABEL", key: "error.DUPLICATE_LABEL", vars: { label } };
    }
  }
  return { ok: true, label };
}

export function slugifyAccountLabel(label: string, takenSlugs: Iterable<string>): string {
  const taken = new Set<string>([ACCOUNT_CONSTANTS.DEFAULT_SLUG]);
  for (const slug of takenSlugs) taken.add(slug.toLowerCase());

  const normalized = normalizeAccountLabel(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = (normalized.slice(0, ACCOUNT_CONSTANTS.SLUG_MAX).replace(/-+$/g, "") || "account");

  if (!taken.has(base)) return base;
  let suffix = 2;
  for (;;) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
    suffix++;
  }
}
