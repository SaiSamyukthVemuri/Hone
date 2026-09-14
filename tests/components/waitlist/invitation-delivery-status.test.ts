import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import {
  InvitationOutcomeNotice,
  type SubmittedInvitation,
} from "@/components/waitlist/invite-outcome-boundary";
import {
  INDETERMINATE_ADMISSION_COPY,
  INVITATION_DELIVERY_COPY,
  invitationNoticeFor,
  invitationRefusalCopy,
} from "@/lib/waitlist/invite-to-book-contract";

// ===========================================================================
// DELIVERY STATUS VISIBILITY — the practitioner is told which of FOUR things
// actually happened
// ===========================================================================
//
// The adapter recorded the gap in its own comment: because the composer's
// action was void, "a `committed / refused` and a `committed / accepted` look
// identical to the practitioner". The truth was computed and thrown away.
//
// Two lies are forbidden in BOTH directions, and each has a case here:
//   * provider acceptance is NOT delivery or readership — nothing this side of
//     the wire observes either;
//   * an invitation that COMMITTED is not uncreated because its email failed —
//     it already consumed the round's allowance.
// ===========================================================================

const submittedFor = (
  notice: ReturnType<typeof invitationNoticeFor>,
  entryName = "Sarah",
  entryId = "entry-1",
): SubmittedInvitation => ({ entryId, entryName, notice });

const html = (notice: ReturnType<typeof invitationNoticeFor> | null) =>
  renderToStaticMarkup(
    createElement(InvitationOutcomeNotice, {
      submitted: notice ? submittedFor(notice) : null,
    }),
  );

describe("the four distinctions stay apart", () => {
  it("committed + accepted — an invitation exists AND the provider took custody", () => {
    const n = invitationNoticeFor({ state: "committed", expiresAt: "x", delivery: "accepted" });
    expect(n.tone).toBe("success");
    expect(n.invitationExists).toBe(true);
    expect(n.message).toBe(INVITATION_DELIVERY_COPY.accepted);
  });

  it("committed + refused — the invitation EXISTS, the email did not go", () => {
    const n = invitationNoticeFor({ state: "committed", expiresAt: "x", delivery: "refused" });
    expect(n.invitationExists, "a committed invitation was reported as uncreated").toBe(true);
    // Not a success: the surface must not style a failed send as one.
    expect(n.tone).not.toBe("success");
    expect(n.message).toBe(INVITATION_DELIVERY_COPY.refused);
  });

  it("committed + unknown — exists, custody undetermined, claims NEITHER", () => {
    const n = invitationNoticeFor({ state: "committed", expiresAt: "x", delivery: "unknown" });
    expect(n.invitationExists).toBe(true);
    expect(n.tone).not.toBe("success");
    expect(n.message).toBe(INVITATION_DELIVERY_COPY.unknown);
  });

  it("refused — nothing was created", () => {
    const n = invitationNoticeFor({ state: "refused", code: "already_invited" });
    expect(n.invitationExists).toBe(false);
    expect(n.tone).toBe("error");
    expect(n.message).toBe(invitationRefusalCopy("already_invited"));
    expect(n.message).toMatch(/No invitation was created/);
  });

  it("indeterminate — never 'failed', never a bare retry", () => {
    const n = invitationNoticeFor({ state: "indeterminate", code: "unavailable" });
    expect(n.message).toBe(INDETERMINATE_ADMISSION_COPY);
    // An invitation MAY exist and may already hold the round's allowance, so
    // this must not read as a definite failure.
    expect(n.tone).not.toBe("error");
    expect(n.message).not.toMatch(/failed/i);
    expect(n.message).toMatch(/Check the waitlist/);
  });

  it("the three committed cases are MUTUALLY DISTINGUISHABLE", () => {
    const messages = (["accepted", "refused", "unknown"] as const).map(
      (delivery) =>
        invitationNoticeFor({ state: "committed", expiresAt: "x", delivery }).message,
    );
    expect(new Set(messages).size, "two committed cases read identically").toBe(3);
  });
});

describe("the forbidden claims are absent", () => {
  it("never describes provider acceptance as delivered or read", () => {
    const accepted = invitationNoticeFor({
      state: "committed", expiresAt: "x", delivery: "accepted",
    }).message;
    expect(accepted).not.toMatch(/\b(delivered|received|read|opened)\b/i);
    expect(accepted).toMatch(/accepted for delivery/i);
  });

  it("never calls a committed invitation uncreated when the email failed", () => {
    for (const delivery of ["refused", "unknown"] as const) {
      const m = invitationNoticeFor({ state: "committed", expiresAt: "x", delivery }).message;
      expect(m, delivery).toMatch(/Invitation created/i);
      expect(m, delivery).not.toMatch(/No invitation was created/i);
    }
  });

  it("does not infer delivery success where evidence is absent", () => {
    // Nothing maps to `accepted` except an explicit accepted disposition.
    const notAccepted = [
      invitationNoticeFor({ state: "committed", expiresAt: "x", delivery: "unknown" }),
      invitationNoticeFor({ state: "committed", expiresAt: "x", delivery: "refused" }),
      invitationNoticeFor({ state: "indeterminate", code: "unavailable" }),
      invitationNoticeFor(null, "malformed_submission"),
    ];
    for (const n of notAccepted) {
      expect(n.message).not.toBe(INVITATION_DELIVERY_COPY.accepted);
      expect(n.tone).not.toBe("success");
    }
  });
});

describe("a submission the boundary would not forward", () => {
  it("says nothing was created, and points at the form", () => {
    const n = invitationNoticeFor(null, "malformed_submission");
    expect(n.invitationExists).toBe(false);
    expect(n.tone).toBe("error");
    expect(n.message).toMatch(/No invitation was created/);
    expect(n.message).toMatch(/form was incomplete/);
  });
});

describe("rendered output", () => {
  it("renders nothing before a submission — no premature claim", () => {
    expect(html(null)).toBe("");
  });

  it("announces the result politely, carrying tone and existence for the surface", () => {
    const markup = html(
      invitationNoticeFor({ state: "committed", expiresAt: "x", delivery: "refused" }),
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('data-tone="warning"');
    expect(markup).toContain('data-invitation-exists="true"');
    expect(markup).toContain(INVITATION_DELIVERY_COPY.refused);
  });

  it("every outcome renders a visible message", () => {
    const all = [
      invitationNoticeFor({ state: "committed", expiresAt: "x", delivery: "accepted" }),
      invitationNoticeFor({ state: "committed", expiresAt: "x", delivery: "refused" }),
      invitationNoticeFor({ state: "committed", expiresAt: "x", delivery: "unknown" }),
      invitationNoticeFor({ state: "refused", code: "not_owner" }),
      invitationNoticeFor({ state: "indeterminate", code: "unavailable" }),
      invitationNoticeFor(null, "malformed_submission"),
    ];
    for (const n of all) {
      const markup = html(n);
      expect(markup).toContain('data-testid="invite-outcome"');
      expect(markup.length).toBeGreaterThan(n.message.length);
    }
  });
});

// ===========================================================================
// THE BINDING — the result must actually reach the composer
// ===========================================================================
//
// The translation above is only useful if the surface consumes a result at all.
// These read the executable source, comment-stripped, so a prose promise cannot
// satisfy them. They exist because the previous state of this code computed the
// truth correctly and then discarded it.

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../..");
const code = (rel: string) =>
  readFileSync(path.join(ROOT, rel), "utf8")
    .replace(/\/\/.*$/gm, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");

const COMPOSER = code("components/waitlist/invite-composer.tsx");
const PAGE = code("app/(app)/settings/waitlist/page.tsx");
const ACTIONS = code("app/(app)/settings/waitlist/invite-actions.ts");
const BOUNDARY = code("components/waitlist/invite-outcome-boundary.tsx");

describe("the structured result reaches the practitioner", () => {
  it("the BOUNDARY owns the result, not the composer", () => {
    // The composer unmounts on a committed admission; whatever it owned dies
    // with it. These assertions exist so that cannot be reintroduced.
    expect(BOUNDARY).toMatch(/useActionState</);
    expect(BOUNDARY).toMatch(/invitationNoticeFor\(/);
    expect(COMPOSER).not.toMatch(/useActionState/);
    expect(COMPOSER).not.toMatch(/invitationNoticeFor/);
  });

  it("the composer submits through the boundary's action", () => {
    expect(COMPOSER).toMatch(/const outcomeAction = useInviteOutcomeAction\(\)/);
    expect(COMPOSER).toMatch(/action=\{outcomeAction \?\? action \?\? undefined\}/);
  });

  it("the boundary captures identity from THIS submission, before the action runs", () => {
    const capture = BOUNDARY.search(/formData\.get\(OUTCOME_ENTRY_FIELD\)/);
    const call = BOUNDARY.search(/await action\(formData\)/);
    expect(capture).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(-1);
    expect(capture, "identity captured after the round trip").toBeLessThan(call);
  });

  it("the VOID binding still works — #683's contract is untouched", () => {
    // Additive, not a replacement: callers passing only `action` are unaffected.
    expect(COMPOSER).toMatch(/action\?: InviteComposerAction \| null;/);
    expect(ACTIONS).toMatch(/export async function inviteToBookFormAction/);
  });

  it("DUPLICATE SUBMISSION is refused while a send is in flight, per form", () => {
    // Scoped to the enclosing form: inviting one prospect must not freeze every
    // other row, which a boundary-wide pending flag would have done.
    expect(COMPOSER).toMatch(/useFormStatus\(\)/);
    expect(COMPOSER).toMatch(/disabled=\{disabled \|\| pending\}/);
  });

  it("a composer with NEITHER binding still refuses to send", () => {
    expect(COMPOSER).toMatch(/const unbound = action === null && outcomeAction === null/);
  });

  it("the page mounts the boundary ABOVE the sections, and revalidation stays", () => {
    expect(PAGE).toMatch(/<InviteOutcomeBoundary\s+action=\{inviteToBookAction\}/);
    // The prospect name comes from SERVER state, never from a hidden form field.
    expect(PAGE).toMatch(/entryNames=\{Object\.fromEntries\(rows\.map/);
    // No HIDDEN field carries the name: the composer's own guard requires every
    // hidden input to be a declared intent field, and a display name is not one.
    expect(COMPOSER).not.toMatch(/type="hidden"[^>]*entryName/);
    // It must enclose the section map, which is what the row lives inside.
    const open = PAGE.search(/<InviteOutcomeBoundary/);
    const map = PAGE.search(/visibleSections\.map\(/);
    const close = PAGE.search(/<\/InviteOutcomeBoundary>/);
    expect(open).toBeLessThan(map);
    expect(map).toBeLessThan(close);
    expect(PAGE).not.toMatch(/action=\{inviteToBookFormAction\}/);
  });

  it("no resend, reissue, return-to-waitlist or removal was added", () => {
    for (const forbidden of [/resend/i, /reissue/i, /returnToWaitlist/i, /removeEntry/i]) {
      expect(COMPOSER, String(forbidden)).not.toMatch(forbidden);
    }
  });
});
