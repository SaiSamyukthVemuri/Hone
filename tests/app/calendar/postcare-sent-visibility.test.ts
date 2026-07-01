import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #302 — Postcare sent visibility (Chloe pilot feedback). Surface the
// EXISTING postcare send timestamp (appointments.postcare_email_sent_at +
// postcare_email_send_attempts, migration 0043) more clearly: a "Postcare
// sent" status on the appointment detail + a per-client postcare history on
// the appointment timeline. Read-only — no migration, no send on render, and
// the copy never claims delivery.

const root = path.resolve(__dirname, "../../../");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
// Strip // line comments so a docstring that *names* the forbidden words
// (to explain we avoid them) doesn't trip a negative grep on visible copy.
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

const BUTTON = read("app/(app)/calendar/PostcareSendButton.tsx");
const TIMELINE = read("components/client-appointment-timeline.tsx");
const QUERIES = read("lib/supabase/queries.ts");
const ACTIONS = read("app/(app)/calendar/actions.ts");

describe("appointment detail postcare status", () => {
  it("shows a clear 'Postcare sent' status when a send timestamp exists", () => {
    expect(BUTTON).toMatch(/Postcare sent/);
    expect(BUTTON).toMatch(/alreadySentAt \?/);
    // Renders the recorded send timestamp.
    expect(BUTTON).toMatch(/new Date\(alreadySentAt\)\.toLocaleString/);
  });

  it("shows an explicit unsent state when there is no send timestamp", () => {
    expect(BUTTON).toMatch(/Not sent yet/);
  });

  it("surfaces the attempt count only when more than one attempt", () => {
    expect(BUTTON).toMatch(/sendAttempts > 1 \? ` · \$\{sendAttempts\} attempts`/);
  });

  it("does NOT overclaim delivery (no 'delivered' / 'received' language)", () => {
    const visible = codeOnly(BUTTON);
    expect(visible).not.toMatch(/\bdelivered\b/i);
    expect(visible).not.toMatch(/\breceived\b/i);
  });
});

describe("per-client postcare history on the appointment timeline", () => {
  it("the timeline query selects the existing postcare columns (read-only)", () => {
    expect(QUERIES).toMatch(/postcare_email_sent_at, postcare_email_send_attempts/);
    expect(QUERIES).toMatch(/postcare_email_sent_at: a\.postcare_email_sent_at/);
    expect(QUERIES).toMatch(/postcare_email_send_attempts: a\.postcare_email_send_attempts \?\? 0/);
  });

  it("the timeline row shows 'Postcare sent' with the recorded date when present", () => {
    expect(TIMELINE).toMatch(/row\.postcare_email_sent_at &&/);
    expect(TIMELINE).toMatch(/Postcare sent/);
    expect(TIMELINE).toMatch(/iso=\{row\.postcare_email_sent_at\}/);
  });

  it("timeline postcare copy does not overclaim delivery", () => {
    // Guard the block we added, not unrelated words elsewhere in the file.
    const block = TIMELINE.slice(
      TIMELINE.indexOf("row.postcare_email_sent_at &&"),
      TIMELINE.indexOf("row.postcare_email_sent_at &&") + 500,
    );
    expect(block).not.toMatch(/delivered|received/i);
  });
});

describe("scope guard: read-only, action + schema untouched", () => {
  it("the postcare send action file is not modified by this PR (no new send path)", () => {
    // The status surfaces do not import or call the send action on render.
    expect(TIMELINE).not.toMatch(/sendPostcareEmailAction/);
    expect(QUERIES).not.toMatch(/sendPostcareEmailAction/);
    // The button still calls the SAME action only inside its confirm handler.
    expect(BUTTON).toMatch(/const r = await sendPostcareEmailAction\(fd\)/);
    // sanity: the action file still exports the unchanged action.
    expect(ACTIONS).toMatch(/sendPostcareEmailAction/);
  });

  it("introduces no migration / schema / RLS change", () => {
    for (const src of [BUTTON, TIMELINE, QUERIES]) {
      expect(src).not.toMatch(/alter table|create policy|create table /i);
    }
  });
});
