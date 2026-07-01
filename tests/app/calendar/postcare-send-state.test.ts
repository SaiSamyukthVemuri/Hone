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
describe("sendPostcareEmailAction: claim via claimed_at, not sent_at", () => {
  it("first send claims postcare_email_claimed_at (NOT sent_at) before the provider call", () => {
    // The claim UPDATE sets claimed_at + last_attempt_at + attempts, guarded by
    // sent_at IS NULL, and does NOT set sent_at in the claim.
    expect(ACTION_CODE).toMatch(/postcare_email_claimed_at: nowIso/);
    expect(ACTION_CODE).toMatch(/postcare_email_last_attempt_at: nowIso/);
    expect(ACTION_CODE).toMatch(/\.is\("postcare_email_sent_at", null\)/);
    expect(ACTION_CODE).toMatch(/\.select\("id"\)/);
    // The claim precedes the provider send.
    const claimIdx = ACTION_CODE.indexOf("postcare_email_claimed_at: nowIso");
    const sendIdx = ACTION_CODE.indexOf("sendPostcareToClient(");
    expect(claimIdx).toBeGreaterThan(-1);
    expect(sendIdx).toBeGreaterThan(claimIdx);
  });

  it("has a stale-claim guard (reclaimable ~5 min)", () => {
    expect(ACTIONS).toMatch(/POSTCARE_CLAIM_STALE_MS = 5 \* 60_000/);
    expect(ACTION_CODE).toMatch(/postcare_email_claimed_at\.is\.null,postcare_email_claimed_at\.lt\.\$\{staleCutoffIso\}/);
  });

  it("increments send_attempts on every attempt (first send + resend)", () => {
    expect(count(ACTION_CODE, /postcare_email_send_attempts: previousAttempts \+ 1/g)).toBe(2);
    expect(count(ACTION_CODE, /postcare_email_last_attempt_at: nowIso/g)).toBe(2);
  });
});

describe("sendPostcareEmailAction: sent_at only AFTER provider success", () => {
  it("sets sent_at only in the success branch, after the provider result is ok", () => {
    const sendIdx = ACTION_CODE.indexOf("sendPostcareToClient(");
    const sentIdx = ACTION_CODE.indexOf("postcare_email_sent_at: nowIso");
    // The ONLY sent_at write happens after the provider call.
    expect(sentIdx).toBeGreaterThan(sendIdx);
    expect(count(ACTION_CODE, /postcare_email_sent_at: nowIso/g)).toBe(1);
    // Success write clears failure state + claim.
    expect(ACTION_CODE).toMatch(
      /postcare_email_sent_at: nowIso,\s*postcare_email_failed_at: null,\s*postcare_email_last_error: null,\s*postcare_email_claimed_at: null/,
    );
  });
});

describe("sendPostcareEmailAction: provider failure is honest", () => {
  it("failure sets failed_at + safe last_error + clears claim, and does NOT set sent_at", () => {
    // The failure branch is between `if (!result.ok)` and the success write
    // (`successWriteErr`); slice on code, not comments (codeOnly strips those).
    const failStart = ACTION_CODE.indexOf("if (!result.ok)");
    const successStart = ACTION_CODE.indexOf("successWriteErr");
    expect(failStart).toBeGreaterThan(-1);
    expect(successStart).toBeGreaterThan(failStart);
    const fb = ACTION_CODE.slice(failStart, successStart);
    expect(fb).toMatch(/postcare_email_failed_at: nowIso/);
    expect(fb).toMatch(/postcare_email_last_error: safePostcareLastError\(result\.retryable\)/);
    expect(fb).toMatch(/postcare_email_claimed_at: null/);
    // The failure branch never stamps sent_at (preserves a prior real send on
    // resend; leaves first-send "not sent").
    expect(fb).not.toMatch(/postcare_email_sent_at: nowIso/);
  });

  it("last_error is SAFE/GENERIC — never raw provider payload or client PII", () => {
    expect(ACTIONS).toMatch(/function safePostcareLastError/);
    expect(ACTIONS).toMatch(/Temporary email provider error\. Try again\./);
    expect(ACTIONS).toMatch(/The email provider rejected the send\. Try again\./);
    // Never stores result.error (raw), client email/name, or a stringified payload.
    expect(ACTION_CODE).not.toMatch(/postcare_email_last_error:\s*result\.error/);
    expect(ACTION_CODE).not.toMatch(/postcare_email_last_error:[^,]*(client\.|clientEmail|clientName|JSON\.stringify)/);
  });
});

// ---------------------------------------------------------------------------
// UI states
// ---------------------------------------------------------------------------
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
  it("the page computes a server-side 'sending' flag (stale-claim aware, no client Date.now)", () => {
    expect(PAGE).toMatch(/sending=\{/);
    expect(PAGE).toMatch(/Date\.now\(\) - new Date\(props\.postcareEmailClaimedAt\)\.getTime\(\) </);
    expect(PAGE).toMatch(/failedAt=\{props\.postcareEmailFailedAt\}/);
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
