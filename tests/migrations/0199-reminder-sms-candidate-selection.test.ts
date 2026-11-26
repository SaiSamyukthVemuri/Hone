import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// 0199 — WAIT S3, bounded server-side reminder candidate selection (applied,
// frozen). These pin the application code that the selection relies on.

const ROOT = path.resolve(__dirname, "../..");

describe("0199: the send path still re-reads consent", () => {
  it("the client gates are a SNAPSHOT, not authority — the gate still re-reads", () => {
    const send = readFileSync(
      path.join(ROOT, "lib/sms/send-appointment.ts"),
      "utf8",
    ).replace(/\/\/.*$/gm, " ");
    // Consent and opt-out change; selection only decides what is worth
    // loading. The live gate is what refuses.
    expect(send).toContain("passesConsentGate({");
    expect(send).toMatch(/sms_opted_out_at/);
    expect(send).toMatch(/sms_consent_at/);
  });
});

describe("0199: the complement contract is parked until its consumer lands", () => {
  it("its CONSUMER has not landed yet — the route contract arrives with #716", () => {
    // MIGRATION APPLIED, CONSUMER UNMERGED. This is the ordinary consequence of
    // reconciling an applied migration ahead of the PR that uses it: 0199 is in
    // production and frozen, while the cron route that calls
    // `reminder_sms_unroutable_studios` is #716 RUNTIME and was deliberately NOT
    // taken into this reconciliation branch.
    //
    // THE REVIEWED CONTRACT IS NOT DELETED, IT IS PARKED, and the assertion
    // below is POSITIVE so it cannot be forgotten: it goes RED the moment #716's
    // route lands, which is exactly when the two lines beneath it must be
    // restored in its place.
    //
    //     expect(route).toMatch(/unroutableStudiosWithCandidates/);
    //     expect(route).not.toMatch(/unroutableStudiosWithCandidates[^;]*onlyStudioIds/);
    //
    // Their meaning, preserved so the restorer does not have to re-derive it:
    // the complement reads `ops_alerts` ONLY to decide what to REPORT. It must
    // not gate sending, selection, or anything else.
    //
    // A skipped test would have rotted silently. This one cannot: the repository
    // either has the pre-#716 route, and this passes, or it has #716's route,
    // and this fails until the contract above is put back.
    const route = readFileSync(
      path.join(ROOT, "app/api/cron/appointment-reminders/route.ts"),
      "utf8",
    ).replace(/\/\/.*$/gm, " ");
    expect(
      route.includes("unroutableStudiosWithCandidates"),
      "#716's cron route has landed. RESTORE the two parked assertions in the " +
        "comment above, in place of this one — 0199's complement contract is " +
        "unenforced until you do.",
    ).toBe(false);
  });
});
