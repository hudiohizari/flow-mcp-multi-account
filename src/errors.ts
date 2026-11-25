import { z } from "zod";
import { t } from "./i18n.js";

export const ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INVALID_STATE: "INVALID_STATE",
  NOTHING_TO_RETRY: "NOTHING_TO_RETRY",
  MAX_CREDITS_EXCEEDED: "MAX_CREDITS_EXCEEDED",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN_HOST: "FORBIDDEN_HOST",
  PATH_OUTSIDE_ALLOWLIST: "PATH_OUTSIDE_ALLOWLIST",
  NOT_FOUND: "NOT_FOUND",
  ACCOUNT_NOT_FOUND: "ACCOUNT_NOT_FOUND",
  JOB_NOT_FOUND: "JOB_NOT_FOUND",
  MEDIA_NOT_FOUND: "MEDIA_NOT_FOUND",
  DUPLICATE_LABEL: "DUPLICATE_LABEL",
  ACCOUNT_DISABLED: "ACCOUNT_DISABLED",
  CANNOT_DISABLE_ACTIVE: "CANNOT_DISABLE_ACTIVE",
  CANNOT_DISABLE_LAST: "CANNOT_DISABLE_LAST",
  CANNOT_REMOVE_ACTIVE: "CANNOT_REMOVE_ACTIVE",
  CANNOT_REMOVE_DEFAULT: "CANNOT_REMOVE_DEFAULT",
  CHROME_BUSY: "CHROME_BUSY",
  SWITCH_IN_PROGRESS: "SWITCH_IN_PROGRESS",
  NOT_IN_PROJECT: "NOT_IN_PROJECT",
  ACCOUNT_MISMATCH: "ACCOUNT_MISMATCH",
  INSUFFICIENT_CREDITS: "INSUFFICIENT_CREDITS",
  AUTO_FAILOVER_DISABLED: "AUTO_FAILOVER_DISABLED",
  ACCOUNT_BOUND_FAILOVER_BLOCKED: "ACCOUNT_BOUND_FAILOVER_BLOCKED",
  FAILOVER_EXHAUSTED: "FAILOVER_EXHAUSTED",
  REGISTRY_CORRUPT: "REGISTRY_CORRUPT",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  PROFILE_MISSING: "PROFILE_MISSING",
  PROFILE_LOCKED: "PROFILE_LOCKED",
  CDP_WRONG_PROFILE: "CDP_WRONG_PROFILE",
  CDP_PORT_OCCUPIED: "CDP_PORT_OCCUPIED",
  CDP_UNAVAILABLE: "CDP_UNAVAILABLE",
  CHROME_NOT_FOUND: "CHROME_NOT_FOUND",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
export type HttpStatus = 400 | 401 | 403 | 404 | 409 | 500 | 503;

export interface ErrorBody {
  error: string;
  code: ErrorCode;
  meta?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly status: HttpStatus;
  readonly code: ErrorCode;
  readonly meta?: Record<string, unknown>;

  constructor(status: HttpStatus, code: ErrorCode, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.meta = meta;
  }
}

export function toErrorPayload(err: unknown): { status: HttpStatus; body: ErrorBody } {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: { error: err.message, code: err.code, ...(err.meta ? { meta: err.meta } : {}) },
    };
  }
  if (err instanceof z.ZodError) {
    const details = err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { status: 400, body: { error: t("error.VALIDATION_ERROR", { details }), code: ERROR_CODES.VALIDATION_ERROR } };
  }
  if (err instanceof SyntaxError) {
    return { status: 400, body: { error: t("error.VALIDATION_ERROR", { details: err.message }), code: ERROR_CODES.VALIDATION_ERROR } };
  }
  if (err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError) {
    return { status: 500, body: { error: err.message, code: ERROR_CODES.INTERNAL_ERROR } };
  }
  if (err instanceof Error) {
    return { status: 400, body: { error: err.message, code: ERROR_CODES.INVALID_STATE } };
  }
  return { status: 500, body: { error: String(err), code: ERROR_CODES.INTERNAL_ERROR } };
}
