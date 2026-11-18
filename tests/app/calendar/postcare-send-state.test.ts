import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #311. Postcare send-state correctness. The P1: sendPostcareEmailAction
// used postcare_email_sent_at as BOTH the first-send claim AND the "sent"
// marker, stamping it BEFORE the Resend call — so a provider failure left a
// false "Postcare sent". The corrected claim / provider / settle flow is proved
// behaviourally in b8-manual-postcare-command.test.ts; this file keeps the
// source tripwires that test cannot see and the UI state copy.

const root = path.resolve(__dirname, "../../../");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const codeOnly = (src: string) =>
  src.split("\n").filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l)).join("\n");

const ACTIONS = read("app/(app)/calendar/actions.ts");
const BUTTON = read("app/(app)/calendar/PostcareSendButton.tsx");
const PAGE = read("app/(app)/calendar/[id]/page.tsx");

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
// behavioural coverage lives in the DB matrix (42/42), the auto RPC suite and
// b8-manual-postcare-command.test.ts.
// ---------------------------------------------------------------------------

describe("sendPostcareEmailAction: the database owns the clock", () => {
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
});

describe("sendPostcareEmailAction: settlement payload", () => {
  it("sends no provider text to the database", () => {
    // The safe operator-facing copy is derived in SQL from `retryable` alone.
    expect(ACTION_CODE).not.toMatch(/p_error|p_message|p_last_error/);
    expect(ACTION_CODE).not.toMatch(/safePostcareLastError/);
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

describe("the action read carries the claim columns", () => {
  it("the action select loads claimed_at + failed_at", () => {
    expect(ACTION).toMatch(/postcare_email_claimed_at, postcare_email_failed_at/);
  });
});
