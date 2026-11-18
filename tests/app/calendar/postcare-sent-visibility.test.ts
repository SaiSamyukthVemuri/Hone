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

const BUTTON = read("app/(app)/calendar/PostcareSendButton.tsx");
const TIMELINE = read("components/client-appointment-timeline.tsx");
const QUERIES = read("lib/supabase/queries.ts");
const ACTIONS = read("app/(app)/calendar/actions.ts");

describe("appointment detail postcare status", () => {
  it("surfaces the attempt count only when more than one attempt", () => {
    expect(BUTTON).toMatch(/sendAttempts > 1 \? ` · \$\{sendAttempts\} attempts`/);
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

describe("scope guard: one send path, reached only from the confirm handler", () => {
  it("the postcare send action file is not modified by this PR (no new send path)", () => {
    // The status surfaces do not import or call the send action on render.
    expect(TIMELINE).not.toMatch(/sendPostcareEmailAction/);
    expect(QUERIES).not.toMatch(/sendPostcareEmailAction/);
    // The button still reaches the SAME action, and only from its confirm
    // handler. B8/0177 review moved the CALL one level down: confirm() hands
    // the action to runPostcareSend as a dependency, which is what makes
    // "exactly one send, never a retry" drivable by a test with a mocked
    // action (tests/app/calendar/b8-postcare-provider-unrecorded.test.ts).
    // The property this guard exists for is unchanged — there is still exactly
    // one send path and it is still triggered only by an explicit confirm — so
    // it is restated against the wiring that now exists.
    const confirm = BUTTON.match(/function confirm\(\)\s*\{[\s\S]*?\n {2}\}/)?.[0] ?? "";
    expect(confirm).not.toBe("");
    expect(confirm).toMatch(/send: sendPostcareEmailAction/);
    expect((BUTTON.match(/sendPostcareEmailAction/g) ?? []).length).toBe(2); // import + the one use
    // sanity: the action file still exports the unchanged action.
    expect(ACTIONS).toMatch(/sendPostcareEmailAction/);
  });
});
