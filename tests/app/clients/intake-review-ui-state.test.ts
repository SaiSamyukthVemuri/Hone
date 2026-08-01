import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// F-CLIN-004 — UI state model pins for the intake review surface.
//
// CONVENTION NOTE. The unit lane runs `environment: "node"` and the repo ships
// no jsdom / React Testing Library (see tests/lib/consent/signature-status.ts:108
// for the same statement). So structure is pinned here by source assertion, and
// the REAL rendered behaviour — Cancel issuing zero requests, one transition per
// confirm, 44px targets measured in a live layout, no horizontal overflow at
// 390px, reload-durable Reviewed state — is proven in the browser E2E lane by
// e2e/intake-review-integrity.spec.ts, using database state as the oracle.
//
// These pins exist so a future edit cannot silently reintroduce the defect:
// the review CTA must never be reachable for an intake the client has not
// submitted.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}
// Strip // line comments and {/* jsx */} blocks so negative greps target real
// code, not prose that legitimately names a forbidden symbol.
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

const FORM = read("app/(app)/clients/[id]/intake/IntakeReviewForm.tsx");
const FORM_CODE = codeOnly(FORM);
const PAGE = read("app/(app)/clients/[id]/intake/page.tsx");
const PAGE_CODE = codeOnly(PAGE);
const ACTIONS = read("app/(app)/clients/[id]/intake/actions.ts");
const ACTIONS_CODE = codeOnly(ACTIONS);

// Precise slices for the two actions this PR changes. The same file also holds
// the three PRE-EXISTING reissue actions (requestIntakeUpdate / getIntakeLink /
// resendIntakeEmail), which are untouched by this PR and legitimately use the
// service role and a raw clientId revalidate path. Scoping the negative
// assertions keeps them honest instead of accidentally asserting things about
// code this PR does not own.
function slice(from: string, to: string): string {
  const a = ACTIONS_CODE.indexOf(from);
  const b = ACTIONS_CODE.indexOf(to);
  if (a < 0 || b < 0 || b <= a) {
    throw new Error(`slice markers not found or out of order: ${from} → ${to}`);
  }
  return ACTIONS_CODE.slice(a, b);
}
const REVIEW_FN = slice(
  "export async function markIntakeReviewedAction",
  "export async function saveIntakeNotesAction",
);
const NOTES_FN = slice(
  "export async function saveIntakeNotesAction",
  "export type IntakeReissueResult",
);
const CHANGED_ACTIONS = `${REVIEW_FN}\n${NOTES_FN}`;

describe("F-CLIN-004 UI — the boolean is gone, the real status is passed", () => {
  it("the component takes an IntakeStatus, not an alreadyReviewed boolean", () => {
    expect(FORM_CODE).toMatch(/status:\s*IntakeStatus/);
    expect(FORM_CODE).not.toMatch(/alreadyReviewed/);
  });

  it("the page passes the actual server status through", () => {
    expect(PAGE_CODE).toMatch(/status=\{intake\.status\}/);
    expect(PAGE_CODE).not.toMatch(/alreadyReviewed/);
  });

  it("the page passes server-derived reviewed attribution for the durable state", () => {
    expect(PAGE_CODE).toMatch(/reviewedAtIso=\{intake\.reviewed_at\}/);
    expect(PAGE_CODE).toMatch(/reviewedByName=/);
  });
});

describe("F-CLIN-004 UI — the review CTA is gated on submitted ONLY", () => {
  it("Mark reviewed renders only when status === 'submitted'", () => {
    expect(FORM_CODE).toMatch(
      /\{status === "submitted" &&[\s\S]{0,600}?data-testid="intake-mark-reviewed"/,
    );
  });

  it("there is exactly one Mark reviewed control", () => {
    const matches = FORM_CODE.match(/data-testid="intake-mark-reviewed"/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("in_progress renders the durable explanation instead of a CTA", () => {
    expect(FORM_CODE).toMatch(/\{status === "in_progress" &&/);
    expect(FORM).toMatch(
      /The client must submit this intake before it can be marked reviewed\./,
    );
    expect(FORM_CODE).toMatch(/data-testid="intake-review-blocked-notice"/);
  });

  it("reviewed renders a durable server-derived Reviewed state, not a toast", () => {
    expect(FORM_CODE).toMatch(/\{status === "reviewed" &&/);
    expect(FORM_CODE).toMatch(/data-testid="intake-reviewed-state"/);
    // The durable state is built from the server props, never from local state.
    expect(FORM_CODE).toMatch(/reviewedAtIso/);
    expect(FORM_CODE).toMatch(/reviewedByName/);
  });

  // The reviewed timestamp must go through the house FormattedDateTime, which
  // renders empty on SSR and fills in on mount under suppressHydrationWarning.
  // Formatting inline in a client component hydration-mismatches (server
  // timezone vs browser timezone) AND disagrees with the page header, which
  // renders this same value that way.
  it("the reviewed timestamp uses FormattedDateTime, never inline toLocaleString", () => {
    expect(FORM_CODE).toMatch(
      /import \{ FormattedDateTime \} from "@\/components\/formatted-date-time"/,
    );
    expect(FORM_CODE).toMatch(/<FormattedDateTime iso=\{reviewedAtIso\} \/>/);
    expect(FORM_CODE).not.toMatch(/toLocaleString/);
    expect(FORM_CODE).not.toMatch(/toLocaleDateString/);
    expect(FORM_CODE).not.toMatch(/toLocaleTimeString/);
  });

  it("the page keeps its existing incomplete-answers warning for in_progress", () => {
    expect(PAGE).toMatch(
      /The client has not submitted their intake yet\. Responses shown below\s+are what they have entered so far\./,
    );
  });
});

describe("F-CLIN-004 UI — notes stay available in every status", () => {
  it("the textarea is rendered unconditionally, outside any status branch", () => {
    expect(FORM_CODE).toMatch(/data-testid="intake-save-notes"/);
    expect(FORM_CODE).toMatch(/<textarea/);
    // The textarea must not sit inside a status-gated block.
    const textareaIdx = FORM_CODE.indexOf("<textarea");
    const firstGate = FORM_CODE.indexOf('{status === ');
    expect(textareaIdx).toBeGreaterThan(-1);
    expect(firstGate).toBeGreaterThan(textareaIdx);
  });

  it("Save notes is never status-gated", () => {
    const saveIdx = FORM_CODE.indexOf('data-testid="intake-save-notes"');
    const gateIdx = FORM_CODE.indexOf('{status === "submitted" &&');
    expect(saveIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(saveIdx);
  });
});

describe("F-CLIN-004 UI — confirmation is required and safe", () => {
  it("uses the house accessible in-DOM ConfirmDialog, never window.confirm", () => {
    expect(FORM_CODE).toMatch(
      /import \{ ConfirmDialog \} from "@\/components\/confirm-dialog"/,
    );
    expect(FORM_CODE).toMatch(/<ConfirmDialog/);
    expect(FORM_CODE).not.toMatch(/window\.confirm/);
    expect(FORM_CODE).not.toMatch(/\bconfirm\(/);
  });

  // Found by negative control 7: asserting only that <ConfirmDialog> APPEARS
  // lets a mutation like `open={false && confirmOpen}` disable the whole
  // confirmation while the pin stays green. Pin the openness expression
  // exactly, and require the confirm handler to be the review call.
  it("the dialog's open state is exactly the confirmOpen flag — nothing falsified", () => {
    expect(FORM_CODE).toMatch(/<ConfirmDialog\s+open=\{confirmOpen\}/);
    expect(FORM_CODE).not.toMatch(/open=\{false/);
    expect(FORM_CODE).not.toMatch(/open=\{[^}]*&&[^}]*\}/);
    expect(FORM_CODE).toMatch(/onConfirm=\{confirmReview\}/);
  });

  it("the CTA only OPENS the dialog — it never calls a server action", () => {
    // The button's onClick sets dialog state; the action name must not appear
    // anywhere in the button's handler.
    const btn = FORM_CODE.slice(
      FORM_CODE.indexOf('{status === "submitted" &&'),
      FORM_CODE.indexOf('data-testid="intake-mark-reviewed"'),
    );
    expect(btn).toMatch(/setConfirmOpen\(true\)/);
    expect(btn).not.toMatch(/markIntakeReviewedAction/);
  });

  it("Cancel only closes — it performs zero server action calls", () => {
    const cancel = FORM_CODE.slice(FORM_CODE.indexOf("onCancel={"));
    expect(cancel).toMatch(/setConfirmOpen\(false\)/);
    expect(cancel).not.toMatch(/markIntakeReviewedAction/);
    expect(cancel).not.toMatch(/saveIntakeNotesAction/);
    expect(cancel).not.toMatch(/router\.refresh/);
  });

  it("the confirmation explains that Hone records the practitioner and time", () => {
    expect(FORM).toMatch(
      /Hone will record you as the reviewer and stamp the current time/,
    );
  });

  it("the dialog itself provides heading / Confirm / Cancel / keyboard access", () => {
    const DIALOG = read("components/confirm-dialog.tsx");
    expect(DIALOG).toMatch(/role="alertdialog"/);
    expect(DIALOG).toMatch(/aria-modal="true"/);
    expect(DIALOG).toMatch(/aria-labelledby=\{titleId\}/);
    expect(DIALOG).toMatch(/aria-describedby=\{descId\}/);
    // Esc closes only while idle, so it never abandons an in-flight request.
    expect(DIALOG).toMatch(/if \(e\.key === "Escape"\)/);
    expect(DIALOG).toMatch(/if \(!pending\) onCancel\(\)/);
    expect(DIALOG).toMatch(/data-testid="confirm-dialog-confirm"/);
    expect(DIALOG).toMatch(/data-testid="confirm-dialog-cancel"/);
  });

  it("every interactive control is at least 44px high", () => {
    const DIALOG = read("components/confirm-dialog.tsx");
    // Both dialog buttons.
    expect((DIALOG.match(/min-h-\[44px\]/g) ?? []).length).toBeGreaterThanOrEqual(2);
    // Both form buttons.
    expect((FORM.match(/min-h-\[44px\]/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe("F-CLIN-004 UI — single-flight, no optimism, durable refresh", () => {
  it("confirm is single-flight via a synchronous in-flight latch plus isPending", () => {
    expect(FORM_CODE).toMatch(/const inFlight = useRef\(false\)/);
    expect(FORM_CODE).toMatch(/if \(inFlight\.current\) return;/);
    expect(FORM_CODE).toMatch(/inFlight\.current = true;/);
    expect(FORM_CODE).toMatch(/inFlight\.current = false;/);
    expect(FORM_CODE).toMatch(/pending=\{isPending\}/);
  });

  it("no optimistic reviewed state — the component never sets status locally", () => {
    expect(FORM_CODE).not.toMatch(/setStatus\(/);
    expect(FORM_CODE).not.toMatch(/useState.*status/);
  });

  it("BOTH the success and the safe-failure paths call router.refresh()", () => {
    // Slice confirmReview() precisely. An earlier version of this test ended
    // the slice at a marker that a later edit deleted, so indexOf returned -1
    // and slice(start, -1) silently widened to almost the whole file — the
    // assertion still passed, but it was no longer scoped to this function.
    // Both markers are now asserted to exist before the slice is taken.
    const start = FORM_CODE.indexOf("function confirmReview()");
    expect(start, "confirmReview() start marker").toBeGreaterThan(-1);
    const end = FORM_CODE.indexOf("const displayedError", start);
    expect(end, "slice end marker must exist and follow the start").toBeGreaterThan(
      start,
    );
    const confirmFn = FORM_CODE.slice(start, end);
    // Sanity-check the slice really is just this function, not half the file.
    expect(confirmFn.length).toBeLessThan(1200);
    expect(confirmFn).not.toMatch(/<ConfirmDialog/);
    expect((confirmFn.match(/router\.refresh\(\)/g) ?? []).length).toBe(2);
  });

  it("does not use setTimeout as a completion oracle", () => {
    expect(FORM_CODE).not.toMatch(/setTimeout/);
  });

  // Found in adversarial review. Dropping the old setTimeout auto-clear left
  // "Notes saved." on screen forever, so it kept asserting a saved state while
  // the practitioner typed further, UNSAVED clinical notes. Editing the field
  // must invalidate the confirmation.
  it("editing the notes field clears a stale 'Notes saved.' confirmation", () => {
    expect(FORM_CODE).toMatch(/onChange=\{\(e\) => onNotesChange\(e\.target\.value\)\}/);
    expect(FORM_CODE).toMatch(
      /function onNotesChange\(value: string\) \{[\s\S]*?setNotes\(value\);[\s\S]*?if \(savedHint\) setSavedHint\(null\);/,
    );
  });

  // Found in adversarial review. After a refused review the page refreshes onto
  // the real server status; if that status is now `reviewed`, the generic
  // "must submit first" refusal renders directly above the Reviewed banner and
  // contradicts it. The displayed copy must be reconciled against the status.
  it("a review refusal is re-worded once the page settles onto a reviewed row", () => {
    expect(FORM_CODE).toMatch(/const \[errorSource, setErrorSource\]/);
    expect(FORM_CODE).toMatch(/setErrorSource\("review"\)/);
    expect(FORM_CODE).toMatch(/setErrorSource\("notes"\)/);
    expect(FORM_CODE).toMatch(
      /const displayedError =[\s\S]*?errorSource === "review" && status === "reviewed"/,
    );
    expect(FORM).toMatch(
      /This intake was already reviewed\. The current record is shown below\./,
    );
    // The rendered element reads the reconciled value, not the raw error.
    expect(FORM_CODE).toMatch(/\{displayedError && \(/);
    expect(FORM_CODE).toMatch(/\{displayedError\}/);
  });

  it("does not navigate away after a successful review", () => {
    expect(FORM_CODE).not.toMatch(/router\.push/);
    expect(FORM_CODE).not.toMatch(/router\.replace/);
  });
});

describe("F-CLIN-004 actions — the conditional update is the single authority", () => {
  it("the review update carries all six predicates", () => {
    const upd = REVIEW_FN;
    expect(upd).toMatch(/\.eq\("id", intakeId\)/);
    expect(upd).toMatch(/\.eq\("studio_id", studio\.id\)/);
    expect(upd).toMatch(/\.eq\("client_id", clientId\)/);
    expect(upd).toMatch(/\.is\("deleted_at", null\)/);
    expect(upd).toMatch(/\.eq\("status", "submitted"\)/);
    expect(upd).toMatch(/\.not\("submitted_at", "is", null\)/);
    // and proves the affected row
    expect(upd).toMatch(/\.select\(/);
    expect(upd).toMatch(/rows\.length !== 1/);
  });

  it("the notes update carries the same-client and affected-row protections", () => {
    const upd = NOTES_FN;
    expect(upd).toMatch(/\.eq\("id", intakeId\)/);
    expect(upd).toMatch(/\.eq\("studio_id", studio\.id\)/);
    expect(upd).toMatch(/\.eq\("client_id", clientId\)/);
    expect(upd).toMatch(/\.is\("deleted_at", null\)/);
    expect(upd).toMatch(/\.select\(/);
    expect(upd).toMatch(/rows\.length !== 1/);
    // practitioner_notes and nothing else
    expect(upd).toMatch(/\.update\(\{ practitioner_notes: notes \}\)/);
  });

  it("neither changed action returns a raw provider error message", () => {
    expect(CHANGED_ACTIONS).not.toMatch(/error:\s*error\.message/);
    // Both failure strings are fixed literals, not interpolations.
    expect(REVIEW_FN).toMatch(/return \{ ok: false, error: REVIEW_DB_FAILURE \}/);
    expect(REVIEW_FN).toMatch(/return \{ ok: false, error: REVIEW_NOT_PERMITTED \}/);
    expect(NOTES_FN).toMatch(/return \{ ok: false, error: NOTES_DB_FAILURE \}/);
    expect(NOTES_FN).toMatch(/return \{ ok: false, error: NOTES_NOT_PERMITTED \}/);
  });

  it("revalidation uses the DB-returned client_id, never the raw form value", () => {
    expect(REVIEW_FN).toMatch(
      /revalidatePath\(`\/clients\/\$\{reviewedClientId\}`\)/,
    );
    expect(REVIEW_FN).toMatch(
      /revalidatePath\(`\/clients\/\$\{reviewedClientId\}\/intake`\)/,
    );
    expect(NOTES_FN).toMatch(
      /revalidatePath\(`\/clients\/\$\{notedClientId\}\/intake`\)/,
    );
    // The unconstrained FormData value is never used for a revalidate path in
    // either changed action.
    expect(CHANGED_ACTIONS).not.toMatch(
      /revalidatePath\(`\/clients\/\$\{clientId\}`\)/,
    );
    expect(CHANGED_ACTIONS).not.toMatch(
      /revalidatePath\(`\/clients\/\$\{clientId\}\/intake`\)/,
    );
  });

  it("neither changed action uses the service role", () => {
    expect(CHANGED_ACTIONS).not.toMatch(/createAdminClient/);
  });
});

describe("F-CLIN-004 — the open database boundary is recorded in source", () => {
  it("actions.ts states plainly that the DB boundary is still open", () => {
    expect(ACTIONS).toMatch(/F-CLIN-004 REMAINS OPEN at the database boundary/);
    expect(ACTIONS).toMatch(/0162/);
  });

  it("does not claim the finding is closed / remediated / fully fixed", () => {
    expect(ACTIONS).not.toMatch(/F-CLIN-004[^\n]*\b(closed|remediated|fully fixed)\b/i);
  });
});
