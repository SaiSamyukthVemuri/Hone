import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #311. Postcare send-state correctness. The P1: sendPostcareEmailAction
// used postcare_email_sent_at as BOTH the first-send claim AND the "sent"
// marker, stamping it BEFORE the Resend call — so a provider failure left a
// false "Postcare sent". This pins the corrected flow: claim via
// postcare_email_claimed_at, stamp sent_at ONLY after provider success, record
// failed_at + a SAFE last_error on failure, and a 4/5-state UI that never
// overclaims delivery. (calendar actions/UI are source-grep tested.)

const root = path.resolve(__dirname, "../../../");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const codeOnly = (src: string) =>
  src.split("\n").filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l)).join("\n");

const ACTIONS = read("app/(app)/calendar/actions.ts");
const BUTTON = read("app/(app)/calendar/PostcareSendButton.tsx");
const PAGE = read("app/(app)/calendar/[id]/page.tsx");
const TYPES = read("lib/types/database.ts");

// Scope to the postcare action body so other actions can't satisfy the greps.
const ACTION = (() => {
  const s = ACTIONS.indexOf("export async function sendPostcareEmailAction");
  expect(s).toBeGreaterThan(-1);
  // Next exported function after it.
  const rest = ACTIONS.slice(s + 1);
  const nextRel = rest.indexOf("\nexport async function ");
  return nextRel === -1 ? ACTIONS.slice(s) : ACTIONS.slice(s, s + 1 + nextRel);
})();
const ACTION_CODE = codeOnly(ACTION);
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

// ---------------------------------------------------------------------------
// Action: claim / success / failure
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// B8 / 0177 — the action's postcare contract, restated for the ACTUAL
// architecture.
//
// These previously asserted three direct `.update()` payloads on `appointments`
// (claim columns, success columns, failure columns). Those statements are gone:
// the columns are written inside claim_postcare_send / settle_postcare_send.
// Asserting them here would have pinned an architecture the code no longer has,
// so the claims are restated against the boundary that actually exists.
//
// SCOPE: this is a SOURCE-CONTRACT suite — it reads the action's text. The
// behavioural coverage lives in the DB matrix (42/42) and the auto RPC suite.
// ---------------------------------------------------------------------------

describe("sendPostcareEmailAction: claims through the command, never directly", () => {
  it("writes NO appointment column itself — the six live only in SQL now", () => {
    for (const col of [
      "postcare_email_claimed_at",
      "postcare_email_last_attempt_at",
      "postcare_email_send_attempts",
      "postcare_email_sent_at",
      "postcare_email_failed_at",
      "postcare_email_last_error",
    ]) {
      // A read (`.select(...)`) may still name a column; an ASSIGNMENT may not.
      expect(ACTION_CODE, `${col} must not be assigned in TypeScript`).not.toMatch(
        new RegExp(`${col}\\s*:`),
      );
    }
    expect(ACTION_CODE).not.toMatch(/\.update\(/);
  });

  it("claims via claim_postcare_send, exactly once, before the provider", () => {
    expect(count(ACTION_CODE, /claim_postcare_send/g)).toBe(1);
    const claim = ACTION_CODE.indexOf("claim_postcare_send");
    const provider = ACTION_CODE.indexOf("sendPostcareToClient");
    expect(claim).toBeGreaterThan(-1);
    expect(provider).toBeGreaterThan(-1);
    expect(claim, "the claim must precede the provider call").toBeLessThan(provider);
  });

  it("generates no clock value for any postcare state", () => {
    // The stale window, the attempt counter and every state timestamp are the
    // database's. A JS clock here would reintroduce exactly the drift B8 removed.
    expect(ACTION_CODE).not.toMatch(/POSTCARE_CLAIM_STALE_MS/);
    // A `new Date().toISOString()` DOES remain, on log `timestamp:` fields.
    // That is observability metadata, not appointment state, so the assertion
    // targets the thing that matters: no generated clock value is ever passed
    // to the commands or assigned to a postcare column.
    const afterClaim = ACTION_CODE.slice(ACTION_CODE.indexOf("claim_postcare_send"));
    const fabricatedState = afterClaim.match(/new Date\(\)\.toISOString\(\)/g) ?? [];
    const logTimestamps = afterClaim.match(/timestamp: new Date\(\)\.toISOString\(\)/g) ?? [];
    expect(
      fabricatedState.length,
      "every remaining generated timestamp must be a log field, not postcare state",
    ).toBe(logTimestamps.length);
  });

  it("forwards the DB-issued token unchanged into settlement", () => {
    // Re-deriving it would round microseconds away and settlement would miss
    // its own claim, so nothing would ever be recorded as sent.
    expect(ACTION_CODE).toMatch(/const claimToken = claim\.claimed_at;/);
    expect(count(ACTION_CODE, /p_claimed_at: claimToken/g)).toBe(2);
    expect(ACTION_CODE).not.toMatch(/p_claimed_at: new Date/);
    expect(ACTION_CODE).not.toMatch(/p_claimed_at: .*toISOString/);
  });
});

describe("sendPostcareEmailAction: settlement is the only writer", () => {
  it("settles success and failure through the command, with the retryable flag", () => {
    expect(count(ACTION_CODE, /settle_postcare_send/g)).toBe(2);
    expect(ACTION_CODE).toMatch(/p_success: true/);
    expect(ACTION_CODE).toMatch(/p_success: false/);
    expect(ACTION_CODE).toMatch(/p_retryable: result\.retryable/);
  });

  it("sends no provider text to the database", () => {
    // The safe operator-facing copy is derived in SQL from `retryable` alone.
    expect(ACTION_CODE).not.toMatch(/p_error|p_message|p_last_error/);
    expect(ACTION_CODE).not.toMatch(/safePostcareLastError/);
  });

  it("provider success whose settlement fails is NOT reported as sent", () => {
    // Provider truth and persisted truth are different facts.
    expect(ACTION_CODE).toMatch(/provider_sent_status_unrecorded/);
    const code = ACTION_CODE.indexOf("provider_sent_status_unrecorded");
    const okTrue = ACTION_CODE.lastIndexOf("return { ok: true };");
    expect(code).toBeGreaterThan(-1);
    expect(okTrue).toBeGreaterThan(-1);
    expect(code, "the unrecorded-status branch must guard the success return").toBeLessThan(
      okTrue,
    );
  });

  it("refusals are mapped to safe copy and never reach the provider", () => {
    expect(ACTION_CODE).toMatch(/postcareClaimRefusalCopy/);
    expect(ACTION_CODE).toMatch(/claim\.result !== "claimed"/);
    // The refusal return sits before the provider call.
    const refusal = ACTION_CODE.indexOf("postcareClaimRefusalCopy(claim.result)");
    const provider = ACTION_CODE.indexOf("sendPostcareToClient");
    expect(refusal).toBeLessThan(provider);
  });

  it("the completed-only refusal has truthful copy", () => {
    expect(ACTIONS).toMatch(/case "not_completed":/);
    expect(ACTIONS).toMatch(/once the appointment is completed/i);
  });
});
describe("postcare UI states (PostcareSendButton)", () => {
  it("sent → 'Postcare sent'; not-sent → 'Not sent yet'; sending → 'Sending…'", () => {
    expect(BUTTON).toMatch(/Postcare sent/);
    expect(BUTTON).toMatch(/Not sent yet\./);
    expect(BUTTON).toMatch(/Sending…/);
  });
  it("failed-before-success → 'Postcare send failed. Try again.'", () => {
    expect(BUTTON).toMatch(/Postcare send failed\. Try again\./);
  });
  it("resend-failed-after-success → keeps sent + 'Last resend failed. Try again.' sub-note", () => {
    expect(BUTTON).toMatch(/Last resend failed\. Try again\./);
    // The sub-note only renders when alreadySentAt AND failedAt are both set.
    expect(BUTTON).toMatch(/alreadySentAt \?/);
    expect(BUTTON).toMatch(/\) : failedAt \?/);
    expect(BUTTON).toMatch(/\) : sending \?/);
  });
  it("never overclaims delivery/receipt/opened/read", () => {
    const visible = codeOnly(BUTTON);
    expect(visible).not.toMatch(/\b(delivered|received|opened|read receipt|has read)\b/i);
  });
  it("the SHARED postcare section computes a server-side 'sending' flag (stale-claim aware, no client Date.now)", () => {
    // PostcareSection was extracted so the calendar page and the charting
    // "Finish appointment" workflow render ONE implementation. The stale-claim
    // computation moved with it, unchanged, and is still server-side.
    const SHARED = readFileSync(
      path.resolve(__dirname, "../../../components/appointment/postcare-section.tsx"),
      "utf8",
    );
    expect(SHARED).toMatch(/sending=\{/);
    expect(SHARED).toMatch(/Date\.now\(\) - new Date\(props\.postcareEmailClaimedAt\)\.getTime\(\) </);
    expect(SHARED).toMatch(/failedAt=\{props\.postcareEmailFailedAt\}/);
    // The calendar page mounts it rather than reimplementing it.
    expect(PAGE).toMatch(/<PostcareSection/);
    expect(PAGE).not.toMatch(/function PostcareSection/);
  });
});

describe("types + query carry the new columns", () => {
  it("Appointment type gains the 4 columns", () => {
    for (const c of [
      "postcare_email_claimed_at",
      "postcare_email_failed_at",
      "postcare_email_last_error",
      "postcare_email_last_attempt_at",
    ]) {
      expect(TYPES).toMatch(new RegExp(`${c}: string \\| null;`));
    }
  });
  it("the action select loads claimed_at + failed_at", () => {
    expect(ACTION).toMatch(/postcare_email_claimed_at, postcare_email_failed_at/);
  });
});
