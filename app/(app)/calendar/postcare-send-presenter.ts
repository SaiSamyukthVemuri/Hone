"use client";

import { createElement, type ReactElement } from "react";
import type { AppointmentStateActionResult } from "./actions";

// B8 / 0177 — the postcare send OUTCOME, separated from the modal that hosts it.
//
// WHY THIS FILE EXISTS.
//
// `sendPostcareEmailAction` can return three materially different things, and
// the modal previously rendered only two of them. Every `ok: false` became
// `setError(...)` under the copy "Could not send. … Try again", which is a lie
// in one specific case: the provider ACCEPTED the email and only the DATABASE
// settlement failed. Telling a practitioner that a sent email was not sent, and
// then inviting a retry, produces a DUPLICATE aftercare email the moment the
// five-minute claim goes stale and becomes reclaimable.
//
// So the outcome is a closed union rather than a boolean pair, and the mapping,
// the copy and the control affordances live HERE — in a module with no state,
// no hooks and no router — so a test can DRIVE them instead of inferring them
// from the component's source text.
//
// WHY createElement AND NOT JSX. This module is imported by the unit lane so
// its markup can be rendered and asserted. That lane transforms with esbuild
// under the repository's `jsx: "preserve"` tsconfig, which cannot parse JSX,
// and the only alternative was editing vitest.config.ts — a file the CI
// classifier treats as full-matrix shared infrastructure. Authoring the two
// small presentational components with createElement keeps this change inside
// the lanes the diff actually affects. They are ordinary React components.
//
// TRUTHFULNESS RULE FOR EVERY STRING BELOW. Hone possesses exactly one fact
// about an outbound email: whether the provider accepted the handoff. It has no
// delivery receipt, no read receipt and no bounce feedback. No copy here may
// say delivered, received, will receive, or opened.

export type PostcareSendOutcome =
  // Nothing has been attempted yet in this modal session.
  | { kind: "idle" }
  // Provider accepted AND the database recorded it. The only state that may
  // show the ordinary success confirmation.
  | { kind: "sent" }
  // PROVIDER TRUTH != PERSISTED TRUTH. The provider accepted the message; the
  // settlement did not commit, so there is no durable `postcare_email_sent_at`.
  // Neither "sent" nor "failed" is true. Its own state, deliberately.
  | { kind: "provider_unrecorded"; message: string }
  // An ordinary refusal or provider failure. Nothing was emailed.
  | { kind: "error"; message: string };

// Provider HANDOFF, not delivery. The previous copy — "The client will receive
// it within a minute" — asserted a delivery outcome Hone cannot observe.
export const POSTCARE_SENT_NOTICE =
  "Postcare was sent to the email provider. This window will close automatically.";

// The special state's copy. It must communicate four things and avoid one:
// the provider accepted it; Hone could not confirm or record the send status;
// do NOT resend right now; refresh before doing anything else. It must NOT
// contain "Could not send" or "Try again", which would invite the duplicate.
export const POSTCARE_UNRECORDED_NOTICE =
  "The email provider accepted this postcare email, but Hone could not confirm and record its send status. " +
  "Do not send it again right now — that could deliver a second copy to the client. " +
  "Refresh this page to see the current state before taking any further action.";

export const POSTCARE_ERROR_PREFIX = "Could not send.";
export const POSTCARE_ERROR_SUFFIX =
  "Try again, or check the client's email on their profile.";

/**
 * Map a server action result to the outcome the surface may render.
 *
 * The `code` discriminator is the ONLY thing that separates the special state
 * from an ordinary failure, and it is checked before the generic branch so a
 * future refusal code cannot accidentally inherit the special handling.
 */
export function classifyPostcareSendResult(
  r: AppointmentStateActionResult,
): PostcareSendOutcome {
  if (r.ok) return { kind: "sent" };
  if (r.code === "provider_sent_status_unrecorded") {
    return { kind: "provider_unrecorded", message: r.error };
  }
  return { kind: "error", message: r.error };
}

/**
 * A Confirm/Resend control may only be offered while nothing has been sent.
 *
 * `sent` and `provider_unrecorded` both withdraw it, for different reasons:
 * the first because the send succeeded, the second because a second provider
 * call is the specific harm this whole state exists to prevent.
 */
export function postcareConfirmAvailable(outcome: PostcareSendOutcome): boolean {
  return outcome.kind === "idle" || outcome.kind === "error";
}

/** Only an ordinary success may auto-close; the special state must be read. */
export function postcareAutoCloses(outcome: PostcareSendOutcome): boolean {
  return outcome.kind === "sent";
}

/**
 * Run one manual postcare send and report the outcome.
 *
 * The action and the router refresh are INJECTED so this is drivable by a test
 * with a mocked action — which is what makes "exactly one provider send, and no
 * automatic retry" a demonstrated property rather than a source-grep claim.
 *
 * `send` is called EXACTLY ONCE. There is no retry loop, no second settlement,
 * and no browser-side repair of `postcare_email_sent_at` — the six postcare
 * columns are writable only by the 0177 commands and only from the server.
 *
 * `refresh` runs for BOTH `sent` and `provider_unrecorded`. The second is the
 * P1 fix: the server re-render is how the practitioner sees the fresh claim
 * state, which is the state they must act on rather than guessing.
 */
export async function runPostcareSend(
  deps: {
    send: (formData: FormData) => Promise<AppointmentStateActionResult>;
    refresh: () => void;
  },
  formData: FormData,
): Promise<PostcareSendOutcome> {
  const outcome = classifyPostcareSendResult(await deps.send(formData));
  if (outcome.kind === "sent" || outcome.kind === "provider_unrecorded") {
    deps.refresh();
  }
  return outcome;
}

/**
 * The outcome-dependent region of the modal. Pure: props in, markup out.
 */
export function PostcareSendOutcomeNotice({
  outcome,
}: {
  outcome: PostcareSendOutcome;
}): ReactElement | null {
  if (outcome.kind === "sent") {
    return createElement(
      "div",
      {
        role: "status",
        "data-testid": "postcare-outcome-sent",
        className:
          "rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm font-medium text-emerald-900 dark:border-emerald-700/50 dark:bg-emerald-950/30 dark:text-emerald-100",
      },
      POSTCARE_SENT_NOTICE,
    );
  }
  if (outcome.kind === "provider_unrecorded") {
    // Amber, not green and not red — the visual has to carry the same "neither
    // sent nor failed" meaning the copy does. `role="alert"` rather than
    // "status": this is the one outcome that asks the practitioner to act.
    return createElement(
      "div",
      {
        role: "alert",
        "data-testid": "postcare-outcome-provider-unrecorded",
        className:
          "rounded-md border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100",
      },
      POSTCARE_UNRECORDED_NOTICE,
    );
  }
  if (outcome.kind === "error") {
    return createElement(
      "p",
      {
        "data-testid": "postcare-outcome-error",
        className: "text-sm text-red-700 dark:text-red-300",
      },
      `${POSTCARE_ERROR_PREFIX} ${outcome.message} ${POSTCARE_ERROR_SUFFIX}`,
    );
  }
  return null;
}

/**
 * The modal footer. Pure, and the single place that decides whether a control
 * capable of triggering a SECOND provider send is rendered at all.
 */
export function PostcareSendFooter({
  outcome,
  pending,
  canConfirm,
  isResend,
  onCancel,
  onConfirm,
}: {
  outcome: PostcareSendOutcome;
  pending: boolean;
  canConfirm: boolean;
  isResend: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement {
  // Keyed off the OUTCOME, never off `canConfirm`: the caller's flag is about
  // the consultation attestation and the in-flight transition, and a state that
  // must not offer a resend cannot depend on it being false.
  const confirmAvailable = postcareConfirmAvailable(outcome);
  return createElement(
    "footer",
    { className: "flex flex-wrap items-center justify-end gap-2" },
    createElement(
      "button",
      {
        type: "button",
        onClick: onCancel,
        disabled: pending,
        "data-testid": "postcare-cancel",
        className:
          "rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium disabled:opacity-50 dark:border-neutral-700",
      },
      confirmAvailable ? "Cancel" : "Close",
    ),
    confirmAvailable
      ? createElement(
          "button",
          {
            type: "button",
            onClick: onConfirm,
            disabled: !canConfirm,
            "data-testid": "postcare-confirm",
            className:
              "rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-950",
          },
          pending ? "Sending..." : isResend ? "Confirm resend" : "Send postcare",
        )
      : null,
  );
}
