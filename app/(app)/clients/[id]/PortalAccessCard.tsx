"use client";

import { useState, useTransition } from "react";
import { sendPortalLinkAction } from "./portal-link-actions";
import { FormattedDateTime } from "@/components/formatted-date-time";

// Practitioner-side card: get a client into the existing secure portal without
// crafting instructions. "Send portal link" emails a secure magic link (reuses
// the shared hashed/single-use/60-min issuance). "Copy login URL" copies the
// studio portal address (NO token) — safe to paste anywhere. Simple access
// hints (last link sent / last sign-in) read from existing tables.
export function PortalAccessCard({
  clientId,
  portalLoginUrl,
  clientHasEmail,
  lastLinkSentAt,
  lastSeenAt,
}: {
  clientId: string;
  portalLoginUrl: string; // /portal/login?studio=SLUG — no token
  clientHasEmail: boolean;
  lastLinkSentAt: string | null;
  lastSeenAt: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [hint, setHint] = useState<
    | { kind: "idle" }
    | { kind: "sent" }
    | { kind: "copied" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  function handleSend() {
    if (!clientHasEmail) return;
    setHint({ kind: "idle" });
    const fd = new FormData();
    fd.set("client_id", clientId);
    startTransition(async () => {
      const r = await sendPortalLinkAction(fd);
      setHint(r.ok ? { kind: "sent" } : { kind: "error", message: r.error });
    });
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(portalLoginUrl);
      setHint({ kind: "copied" });
      window.setTimeout(() => setHint({ kind: "idle" }), 2000);
    } catch {
      setHint({ kind: "error", message: `Copy this manually: ${portalLoginUrl}` });
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950">
      <div>
        <h3 className="text-sm font-semibold">Client portal access</h3>
        <p className="mt-1 text-xs text-neutral-500">
          Send a secure sign-in link, or copy the studio portal address. The
          client enters their email to receive a one-hour, single-use link — you
          never send a password or a raw token.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={handleSend}
          disabled={pending || !clientHasEmail}
          className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
        >
          {pending ? "Sending…" : "Send portal link"}
        </button>
        <button
          type="button"
          onClick={handleCopy}
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-800 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-900"
        >
          Copy login URL
        </button>
      </div>

      {!clientHasEmail && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Add an email to this client to send a portal link.
        </p>
      )}
      {hint.kind === "sent" && (
        <p className="text-xs text-green-600 dark:text-green-400">
          Secure portal link sent.
        </p>
      )}
      {hint.kind === "copied" && (
        <p className="text-xs text-green-600 dark:text-green-400">
          Portal address copied. The client will enter their email to receive a
          secure sign-in link.
        </p>
      )}
      {hint.kind === "error" && (
        <p className="text-xs text-red-600 dark:text-red-400">{hint.message}</p>
      )}

      <dl className="flex flex-col gap-1 border-t border-neutral-100 pt-2 text-xs text-neutral-500 dark:border-neutral-900">
        <div className="flex justify-between gap-2">
          <dt>Last link sent</dt>
          <dd>
            {lastLinkSentAt ? <FormattedDateTime iso={lastLinkSentAt} /> : "never"}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt>Last portal sign-in</dt>
          <dd>{lastSeenAt ? <FormattedDateTime iso={lastSeenAt} /> : "never"}</dd>
        </div>
      </dl>
    </section>
  );
}
