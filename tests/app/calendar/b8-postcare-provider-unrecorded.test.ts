import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// ===========================================================================
// B8 / 0177 — independent-review P1-1.
//
// THE DEFECT. `sendPostcareEmailAction` distinguishes three outcomes, and the
// server side was already correct: an ordinary refusal, a real success, and the
// one case where the PROVIDER ACCEPTED the email but the database settlement
// did not commit — returned as `code: "provider_sent_status_unrecorded"`.
// The modal collapsed all three into two. Every `ok:false` became
// `setError(r.error)` under "Could not send. … Try again", so the practitioner
// was told a sent email had failed and was invited to send it again. Once the
// five-minute claim goes stale that retry wins a fresh claim and the client
// receives a SECOND aftercare email.
//
// WHY THESE ARE BEHAVIOURAL TESTS, NOT SOURCE GREPS. A substring test over
// PostcareSendButton.tsx would pass on a component that merely MENTIONS the
// code while still rendering the generic branch — the exact class of vacuous
// guard this program has been caught by before. So:
//
//   * the CONTROLLER is driven with a MOCKED action, which is what makes
//     "exactly one provider send, no automatic retry" a demonstrated fact;
//   * the NOTICE and the FOOTER are really rendered to markup through
//     react-dom/server, and the assertions run against that markup.
//
// Both units are pure (no hooks, no router), which is why they can be driven
// directly. The stateful shell composes them and is typechecked against them.
// ===========================================================================

import {
  POSTCARE_ERROR_PREFIX,
  POSTCARE_ERROR_SUFFIX,
  POSTCARE_SENT_NOTICE,
  POSTCARE_UNRECORDED_NOTICE,
  PostcareSendFooter,
  PostcareSendOutcomeNotice,
  classifyPostcareSendResult,
  postcareAutoCloses,
  postcareConfirmAvailable,
  runPostcareSend,
  type PostcareSendOutcome,
} from "@/app/(app)/calendar/postcare-send-presenter";

const UNRECORDED_ERROR =
  "The email provider accepted the message, but Hone could not record the send status. Refresh before trying again.";

/** The exact server result the action returns for this outcome. */
const unrecordedResult = () =>
  ({
    ok: false as const,
    code: "provider_sent_status_unrecorded" as const,
    error: UNRECORDED_ERROR,
  });

function renderNotice(outcome: PostcareSendOutcome): string {
  return renderToStaticMarkup(
    createElement(PostcareSendOutcomeNotice, { outcome }),
  );
}

function renderFooter(
  outcome: PostcareSendOutcome,
  over: Partial<{ pending: boolean; canConfirm: boolean; isResend: boolean }> = {},
): string {
  return renderToStaticMarkup(
    createElement(PostcareSendFooter, {
      outcome,
      pending: over.pending ?? false,
      canConfirm: over.canConfirm ?? true,
      isResend: over.isResend ?? false,
      onCancel: () => undefined,
      onConfirm: () => undefined,
    }),
  );
}

// ---------------------------------------------------------------------------
// U1 — the controller, driven with a mocked action
// ---------------------------------------------------------------------------
describe("U1 — provider accepted, settlement unrecorded: the controller", () => {
  it("classifies it as its own outcome — never success, never a plain error", async () => {
    const send = vi.fn().mockResolvedValue(unrecordedResult());
    const refresh = vi.fn();

    const outcome = await runPostcareSend({ send, refresh }, new FormData());

    expect(outcome.kind).toBe("provider_unrecorded");
    expect(outcome.kind).not.toBe("sent");
    expect(outcome.kind).not.toBe("error");
  });

  it("calls the action EXACTLY ONCE and never retries", async () => {
    // The duplicate-email harm is a SECOND provider send. Nothing in this path
    // may issue one: no retry loop, no second settlement, no browser repair.
    const send = vi.fn().mockResolvedValue(unrecordedResult());
    const refresh = vi.fn();

    await runPostcareSend({ send, refresh }, new FormData());

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("refreshes, so the fresh server-rendered claim state becomes visible", async () => {
    const send = vi.fn().mockResolvedValue(unrecordedResult());
    const refresh = vi.fn();

    await runPostcareSend({ send, refresh }, new FormData());

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("an ORDINARY failure is still an ordinary failure, and does not refresh", async () => {
    // The discriminator has to actually discriminate: a refusal with no code
    // must not inherit any of the special handling above.
    const send = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "Appointment not found." });
    const refresh = vi.fn();

    const outcome = await runPostcareSend({ send, refresh }, new FormData());

    expect(outcome.kind).toBe("error");
    expect(refresh).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a real success is still a real success, and refreshes", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    const refresh = vi.fn();

    const outcome = await runPostcareSend({ send, refresh }, new FormData());

    expect(outcome.kind).toBe("sent");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not auto-close — the practitioner is being asked to act", async () => {
    // Only an ordinary success dismisses itself. This state asks for a refresh,
    // so it must stay on screen.
    expect(postcareAutoCloses({ kind: "provider_unrecorded", message: "x" })).toBe(
      false,
    );
    expect(postcareAutoCloses({ kind: "sent" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// U2 — what the practitioner actually sees (real render)
// ---------------------------------------------------------------------------
describe("U2 — provider accepted, settlement unrecorded: rendered copy", () => {
  const outcome = classifyPostcareSendResult(unrecordedResult());
  const html = renderNotice(outcome);

  it("renders the provider-accepted / unrecorded explanation", () => {
    expect(html).toContain("provider accepted");
    expect(html).toMatch(/could not confirm and record its send status/i);
    // ...and tells the practitioner what to do instead of resending.
    expect(html).toMatch(/refresh/i);
  });

  it("does NOT render the generic 'Could not send' copy", () => {
    expect(html).not.toContain(POSTCARE_ERROR_PREFIX);
    expect(html).not.toMatch(/could not send/i);
  });

  it("does NOT render 'Try again' or any other resend nudge", () => {
    expect(html).not.toMatch(/try again/i);
    expect(html).not.toMatch(/resend now/i);
    expect(html).not.toMatch(/send again now/i);
  });

  it("does NOT render the ordinary green 'Postcare sent' confirmation", () => {
    expect(html).not.toContain(POSTCARE_SENT_NOTICE);
    expect(html).not.toMatch(/postcare sent/i);
    // The success notice is emerald; this one must not be.
    expect(html).not.toMatch(/emerald/);
  });

  it("claims no delivery, receipt or open", () => {
    expect(html).not.toMatch(/\b(delivered|received|will receive|opened)\b/i);
  });

  it("is announced as an alert, not as a completed status", () => {
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('role="status"');
  });
});

// ---------------------------------------------------------------------------
// U3 — the control that could duplicate the email is withdrawn
// ---------------------------------------------------------------------------
describe("U3 — no enabled Confirm send/resend while the state is displayed", () => {
  it("withdraws the confirm button entirely for first send AND resend", () => {
    for (const isResend of [false, true]) {
      const html = renderFooter(
        { kind: "provider_unrecorded", message: UNRECORDED_ERROR },
        { isResend, canConfirm: true },
      );
      // Not merely disabled — absent. `canConfirm: true` is passed on purpose:
      // if the footer keyed off that flag instead of the outcome, this is where
      // it would leak an enabled control.
      expect(html).not.toContain('data-testid="postcare-confirm"');
      expect(html).not.toMatch(/Confirm resend/);
      expect(html).not.toMatch(/Send postcare/);
      expect(html).not.toMatch(/<button(?![^>]*disabled)[^>]*>(?:Send|Confirm)/);
      // The practitioner can still dismiss the modal.
      expect(html).toContain('data-testid="postcare-cancel"');
      expect(html).toContain(">Close</button>");
    }
  });

  it("the same footer DOES offer confirm in the ordinary states", () => {
    // A negative control for the assertion above: if the footer never rendered
    // a confirm button at all, U3 would pass vacuously.
    for (const outcome of [
      { kind: "idle" } as const,
      { kind: "error" as const, message: "boom" },
    ]) {
      const html = renderFooter(outcome);
      expect(html).toContain('data-testid="postcare-confirm"');
      expect(html).toContain(">Send postcare</button>");
    }
    expect(postcareConfirmAvailable({ kind: "idle" })).toBe(true);
    expect(postcareConfirmAvailable({ kind: "error", message: "x" })).toBe(true);
    expect(
      postcareConfirmAvailable({ kind: "provider_unrecorded", message: "x" }),
    ).toBe(false);
    expect(postcareConfirmAvailable({ kind: "sent" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// U4 — the successful-send copy does not overclaim delivery (review P2)
// ---------------------------------------------------------------------------
describe("U4 — successful send copy is provider handoff, not delivery", () => {
  const html = renderNotice({ kind: "sent" });

  it("says the email was handed to the provider", () => {
    expect(POSTCARE_SENT_NOTICE).toBe(
      "Postcare was sent to the email provider. This window will close automatically.",
    );
    expect(html).toContain("sent to the email provider");
  });

  it("never claims delivery, receipt, reading, or a delivery window", () => {
    // B8 defines sent_at as PROVIDER HANDOFF only. The previous copy — "The
    // client will receive it within a minute" — asserted an outcome Hone has no
    // evidence for: there is no delivery receipt and no bounce feedback.
    expect(html).not.toMatch(/\b(delivered|received|will receive|opened|read)\b/i);
    expect(html).not.toMatch(/within a minute/i);
  });
});

// ---------------------------------------------------------------------------
// U5 — the ordinary error path is unchanged
// ---------------------------------------------------------------------------
describe("U5 — ordinary failures keep their existing copy", () => {
  it("still renders 'Could not send. … Try again …'", () => {
    const html = renderNotice({
      kind: "error",
      message: "This client has no email on file.",
    });
    expect(html).toContain(POSTCARE_ERROR_PREFIX);
    expect(html).toContain("This client has no email on file.");
    expect(html).toContain(POSTCARE_ERROR_SUFFIX);
    // The apostrophe stays typographic (U+2019), as it was when this was JSX
    // text carrying `&rsquo;` — a straight quote would be escaped to &#x27;.
    expect(html).toContain("client’s email");
  });

  it("idle renders nothing at all", () => {
    expect(renderNotice({ kind: "idle" })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// U6 — the shell is wired to the presenter (not a substitute for the above)
// ---------------------------------------------------------------------------
describe("U6 — PostcareSendButton composes the presenter", () => {
  it("holds no second outcome model of its own", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(__dirname, "../../../app/(app)/calendar/PostcareSendButton.tsx"),
      "utf8",
    );
    // The union replaced the justSent/error boolean pair. Either survivor would
    // be a second source of truth about what happened.
    expect(src).not.toMatch(/justSent/);
    expect(src).not.toMatch(/setError\(/);
    expect(src).toMatch(/runPostcareSend\(/);
    expect(src).toMatch(/<PostcareSendOutcomeNotice/);
    expect(src).toMatch(/<PostcareSendFooter/);
    // The action is still the only send path, and the refresh is still the
    // component's own router.
    expect(src).toMatch(/send: sendPostcareEmailAction/);
    expect(src).toMatch(/refresh: \(\) => router\.refresh\(\)/);
  });
});
