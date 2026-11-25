import assert from "node:assert/strict";
import test from "node:test";
import { AppError, ERROR_CODES } from "../dist/errors.js";
import {
  assertWithinMaxCredits,
  classifyTileFailure,
  CreditExhaustedError,
  evaluatePreSubmitCredits,
  isCreditExhaustedText,
  isPolicyErrorText,
  parseBalanceCredits,
  parseQuotedCredits,
} from "../dist/flow-credits.js";

test("flow-credits parses comma-formatted quotes/balances, enforces max_credits precedence, and classifies failures", async () => {
  assert.equal(parseQuotedCredits("0 credits"), 0);
  assert.equal(parseQuotedCredits("15 credits"), 15);
  assert.equal(parseQuotedCredits("1,200 credits"), 1200);
  assert.equal(parseQuotedCredits("1,250,000 credits"), 1250000);
  assert.equal(parseQuotedCredits("42"), 42);
  assert.equal(Number.isNaN(parseQuotedCredits("Add AI credits")), true);

  assert.equal(parseBalanceCredits("1,450 Google Flow credits"), 1450);
  assert.equal(parseBalanceCredits("0 Google Flow credits"), 0);
  assert.equal(parseBalanceCredits("Google Flow credits"), undefined);
  assert.equal(parseBalanceCredits(""), undefined);
  assert.equal(parseBalanceCredits("9".repeat(400)), undefined);

  // max_credits: 0 allows 0-credit shots and rejects paid shots with 400 MAX_CREDITS_EXCEEDED
  assertWithinMaxCredits(0, 0);
  assertWithinMaxCredits(25, undefined);
  assertWithinMaxCredits(25, 25);
  assert.throws(
    () => assertWithinMaxCredits(15, 0),
    (err: AppError) => err.status === 400 && err.code === ERROR_CODES.MAX_CREDITS_EXCEEDED && err.meta?.cost === 15,
  );
  assert.throws(
    () => assertWithinMaxCredits(30, 25),
    (err: AppError) => err.status === 400 && err.code === ERROR_CODES.MAX_CREDITS_EXCEEDED,
  );

  // Policy vs credit exhaustion separation
  assert.equal(isPolicyErrorText("Violates policy on prominent people"), true);
  assert.equal(isCreditExhaustedText(""), false);
  assert.equal(isCreditExhaustedText("Policy violation: insufficient credits"), false);
  assert.equal(isCreditExhaustedText("Add AI credits to continue"), true);
  assert.equal(isCreditExhaustedText("Insufficient credits for this generation"), true);
  assert.equal(isCreditExhaustedText("Quota exceeded"), true);
  assert.equal(classifyTileFailure("Safety policy violation"), "policy");
  assert.equal(classifyTileFailure("Out of AI credits"), "credit_exhausted");
  assert.equal(classifyTileFailure("Server temporarily busy"), "other");

  // Precedence: cost > max_credits runs BEFORE readBalance or hasInsufficientUi
  let reads = 0;
  let uiChecks = 0;
  await assert.rejects(
    () =>
      evaluatePreSubmitCredits({
        cost: 30,
        maxCredits: 25,
        readBalance: async () => {
          reads++;
          return 0;
        },
        hasInsufficientUi: async () => {
          uiChecks++;
          return true;
        },
      }),
    (err: AppError) => err.code === ERROR_CODES.MAX_CREDITS_EXCEEDED,
  );
  assert.equal(reads, 0);
  assert.equal(uiChecks, 0);

  // 0-credit shot skips pre-submit balance read and UI checks
  assert.deepEqual(
    await evaluatePreSubmitCredits({
      cost: 0,
      maxCredits: 0,
      readBalance: async () => {
        reads++;
        return 0;
      },
      hasInsufficientUi: async () => {
        uiChecks++;
        return true;
      },
    }),
    {},
  );
  assert.equal(reads, 0);
  assert.equal(uiChecks, 0);

  // Low balance < cost throws CreditExhaustedError carrying balance and cost
  await assert.rejects(
    () =>
      evaluatePreSubmitCredits({
        cost: 15,
        maxCredits: 25,
        readBalance: async () => 10,
        hasInsufficientUi: async () => false,
      }),
    (err: CreditExhaustedError) => err.requiredCost === 15 && err.creditsRemaining === 10 && /10 credits/.test(err.message),
  );

  // Insufficient quote block UI with unreadable balance still throws CreditExhaustedError
  await assert.rejects(
    () =>
      evaluatePreSubmitCredits({
        cost: 15,
        maxCredits: 25,
        readBalance: async () => undefined,
        hasInsufficientUi: async () => true,
      }),
    (err: CreditExhaustedError) => err.requiredCost === 15 && err.creditsRemaining === undefined && /15-credit/.test(err.message),
  );

  // Unreadable balance with no block UI proceeds to submit
  assert.deepEqual(
    await evaluatePreSubmitCredits({
      cost: 15,
      maxCredits: 25,
      readBalance: async () => undefined,
      hasInsufficientUi: async () => false,
    }),
    { creditsRemaining: undefined },
  );

  // Sufficient balance proceeds
  assert.deepEqual(
    await evaluatePreSubmitCredits({
      cost: 15,
      maxCredits: 25,
      readBalance: async () => 100,
      hasInsufficientUi: async () => false,
    }),
    { creditsRemaining: 100 },
  );
});
