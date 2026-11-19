import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #293. Intake link resend / refresh — a UX/discoverability fix over the
// existing safe backend. Source-grep pins (the intake UI is not DOM-rendered
// in the node test env) proving the prominent "Resend intake link" CTA is
// wired to the EXISTING resendIntakeEmailAction (same row → keeps answers),
// never requestIntakeUpdateAction (which starts a new blank intake), on the
// in-progress row, with no new token/PII logging.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}
// Strip // line comments + {/* jsx */} blocks so negative greps target real
// code/UI, not comments that legitimately name a forbidden symbol/label.
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}
const CARD = read("app/(app)/clients/[id]/intake/IntakeResendCard.tsx");
const CARD_CODE = codeOnly(CARD);
const PAGE = read("app/(app)/clients/[id]/intake/page.tsx");
// The practitioner-facing "Health & Forms" tab is this inline overview card,
// not the dedicated /intake page — the #293 follow-up surfaces the CTA here.
const OVERVIEW = read("app/(app)/clients/[id]/page.tsx");

describe("Resend intake link CTA wiring (PR #293)", () => {
  it("the primary CTA calls the existing resendIntakeEmailAction (same row → keeps answers)", () => {
    expect(CARD).toMatch(/resendIntakeEmailAction/);
    // it operates on a passed-in intakeId (the current in-progress row).
    expect(CARD).toMatch(/intakeId/);
    expect(CARD).toMatch(/fd\.set\("intake_id", intakeId\)/);
  });

  it("does NOT call requestIntakeUpdateAction (would start a new blank intake)", () => {
    expect(CARD_CODE).not.toMatch(/requestIntakeUpdateAction/);
  });

  it("provides a Copy link fallback via the existing getIntakeLinkAction", () => {
    expect(CARD).toMatch(/getIntakeLinkAction/);
    expect(CARD).toMatch(/Copy link/);
  });

  it("copy says saved answers are kept and links expire after 14 days", () => {
    expect(CARD).toMatch(/keeps any answers they/);
    expect(CARD).toMatch(/Links expire after 14 days/);
  });

  it("uses the approved generic success and error copy", () => {
    expect(CARD).toMatch(/Intake link sent\./);
    expect(CARD).toMatch(/Could not send the intake link\. Please try again\./);
  });

  it("no-email state disables resend and points to Copy link", () => {
    expect(CARD).toMatch(/disabled=\{isPending \|\| !clientHasEmail\}/);
    expect(CARD).toMatch(/No email on file\. Use Copy link to share it manually\./);
  });

  it("shows the best-effort 'previous link may have expired' hint", () => {
    expect(CARD).toMatch(/The previous link may have expired\./);
  });

  it("adds no token/PII logging (no console / ops-alert in the card)", () => {
    expect(CARD).not.toMatch(/console\./);
    expect(CARD).not.toMatch(/recordOpsAlert/);
  });
});

describe("Health & Forms tab renders the resend CTA for in-progress intakes (PR #293)", () => {
  it("only renders it when the intake is in_progress, on the same row", () => {
    expect(PAGE).toMatch(/intake\.status === "in_progress" &&\s*\(\s*<IntakeResendCard/);
    expect(PAGE).toMatch(/intakeId=\{intake\.id\}/);
  });
});

describe("overview Health & Forms card renders the resend CTA for in-progress intake (PR #293 follow-up)", () => {
  it("renders <IntakeResendCard> inside the in_progress Health intake branch", () => {
    const inProg = OVERVIEW.indexOf('intake?.status === "in_progress"');
    expect(inProg).toBeGreaterThan(-1);
    // The next "submitted" branch AFTER in_progress bounds the block (an
    // earlier "submitted" status badge sits above the in_progress body).
    const submittedAfter = OVERVIEW.indexOf(
      'intake?.status === "submitted"',
      inProg,
    );
    expect(submittedAfter).toBeGreaterThan(inProg);
    const inProgressBlock = OVERVIEW.slice(inProg, submittedAfter);
    expect(inProgressBlock).toMatch(/<IntakeResendCard/);
  });

  it("wires the card to the same intake (intake.id) and the client's email", () => {
    expect(OVERVIEW).toMatch(/intakeId=\{intake\.id\}/);
    expect(OVERVIEW).toMatch(/clientHasEmail=\{!!client\.email\}/);
  });
});
