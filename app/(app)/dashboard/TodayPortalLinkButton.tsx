"use client";

import { useState, useTransition } from "react";
import {
  sendPortalLinkAction,
  type SendPortalLinkResult,
} from "@/app/(app)/clients/[id]/portal-link-actions";

// Chloe: "maybe a one click reminder button that sends an email".
//
// IT REUSES THE EXISTING SERVER AUTHORITY, WHOLE. sendPortalLinkAction already
// resolves the practitioner and studio server-side, refuses inactive
// practitioners, looks the client up WHERE studio_id = the practitioner's
// studio, requires an email on file, rate-limits 3/hour per
// practitioner+client, issues a hashed, single-use, one-hour token, keeps
// clinical / intake / payment data out of the email, and logs the access event.
// This component adds a button and nothing else: no second magic-link
// implementation, no second email integration, no new endpoint.
//
// TRUTHFUL LABEL. It says "Send portal link", NOT "Send card reminder". The
// existing email is a generic secure portal-access email; naming it after the
// card would describe an email Hone does not send.
//
// NOTHING SENSITIVE IS RENDERED. The action returns `{ ok }` or safe copy; the
// raw magic link and the token never leave the server, and no Stripe identifier
// is in scope here at all.
export type PortalSendHint =
  | { kind: "idle" }
  | { kind: "sent" }
  | { kind: "error"; message: string };

/**
 * The action's result -> what the practitioner is told. Pure and exported so
 * both branches are proved by rendering real markup: vitest runs without a DOM
 * here, so a click cannot be simulated, but the copy each outcome produces can
 * be asserted exactly. The error branch passes the action's OWN safe message
 * through unchanged — this surface never invents payment or client detail.
 */
export function hintFromResult(result: SendPortalLinkResult): PortalSendHint {
  return result.ok ? { kind: "sent" } : { kind: "error", message: result.error };
}

/** aria-live so the outcome is announced, not just painted. */
export function PortalSendStatus({ hint }: { hint: PortalSendHint }) {
  return (
    <span aria-live="polite" className="text-right text-[11px]">
      {hint.kind === "sent" && (
        <span
          data-testid="today-portal-link-sent"
          className="text-emerald-700 dark:text-emerald-400"
        >
          Portal link sent.
        </span>
      )}
      {hint.kind === "error" && (
        <span
          data-testid="today-portal-link-error"
          className="text-rose-700 dark:text-rose-400"
        >
          {hint.message}
        </span>
      )}
    </span>
  );
}

export function TodayPortalLinkButton({
  clientId,
  clientHasEmail,
}: {
  clientId: string;
  clientHasEmail: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [hint, setHint] = useState<PortalSendHint>({ kind: "idle" });

  // No email on file means there is no send to offer. The control stays visible
  // and DISABLED with a truthful reason, rather than vanishing and leaving the
  // practitioner to wonder why this row is different.
  if (!clientHasEmail) {
    return (
      <span className="flex flex-col items-end">
        <button
          type="button"
          disabled
          data-testid="today-send-portal-link"
          className="inline-flex min-h-[44px] items-center rounded-md px-3 py-1.5 text-xs font-medium text-neutral-400 opacity-60 dark:text-neutral-500"
        >
          Send portal link
        </button>
        <span className="text-right text-[11px] text-neutral-500 dark:text-neutral-400">
          No email on file
        </span>
      </span>
    );
  }

  function handleSend() {
    setHint({ kind: "idle" });
    const fd = new FormData();
    fd.set("client_id", clientId);
    startTransition(async () => {
      // The action RETURNS its refusals, so `{ok:false}` already routes to its
      // own safe copy below. This catch is for the other class: a REJECTED
      // promise — a transport failure, a deployment-id mismatch on a tab left
      // open across a deploy, or the practitioner/studio resolver throwing.
      //
      // Without it React re-throws the rejection out of the transition and it
      // escapes to the route error boundary, replacing the ENTIRE Today roster
      // because one secondary per-row control failed — and `hint` never gets
      // set, so nothing is announced either. A per-row nudge must fail to its
      // own line. Same shape as StartAssistedIntakeButton, which documents the
      // identical hazard.
      //
      // The thrown value is deliberately NOT rendered: it can carry server
      // internals. The visitor gets fixed, calm copy.
      try {
        setHint(hintFromResult(await sendPortalLinkAction(fd)));
      } catch {
        setHint({ kind: "error", message: "Could not send portal link. Please try again." });
      }
    });
  }

  return (
    <span className="flex flex-col items-end">
      <button
        type="button"
        onClick={handleSend}
        disabled={pending}
        data-testid="today-send-portal-link"
        className="inline-flex min-h-[44px] items-center rounded-md px-3 py-1.5 text-xs font-medium text-neutral-600 underline-offset-2 hover:text-neutral-900 hover:underline disabled:opacity-60 dark:text-neutral-400 dark:hover:text-neutral-100"
      >
        {pending ? "Sending…" : "Send portal link"}
      </button>
      <PortalSendStatus hint={hint} />
    </span>
  );
}
