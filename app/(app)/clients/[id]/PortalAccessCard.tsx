"use client";

import { useState, useTransition } from "react";
import { sendPortalLinkAction } from "./portal-link-actions";
import { FormattedDateTime } from "@/components/formatted-date-time";
import type { PortalPendingTasks } from "@/lib/portal/pending-tasks";

// Minimal, safe-to-render shape of a portal access event (structurally
// satisfied by lib/portal/queries PortalAccessEventRow). No token/URL/PII.
type RecentPortalEvent = {
  id: string;
  eventType: string;
  createdAt: string;
};

const EVENT_LABELS: Record<string, string> = {
  portal_link_sent: "Portal link sent",
  portal_link_rate_limited: "Send rate-limited",
  portal_login_requested: "Sign-in link requested",
  portal_magic_link_consumed: "Signed in",
  portal_session_seen: "Portal opened",
};

// Practitioner-side card: get a client into the existing secure portal without
// crafting instructions. "Send portal link" emails a secure magic link (reuses
// the shared hashed/single-use/60-min issuance). "Copy login URL" copies the
// studio portal address (NO token), safe to paste anywhere. Simple access
// hints (last link sent / last sign-in) read from existing tables.
export function PortalAccessCard({
  clientId,
  portalLoginUrl,
  clientHasEmail,
  lastLinkSentAt,
  lastSeenAt,
  pendingTasks,
  recentEvents = [],
}: {
  clientId: string;
  portalLoginUrl: string; // /portal/login?studio=SLUG, no token
  clientHasEmail: boolean;
  lastLinkSentAt: string | null;
  lastSeenAt: string | null;
  pendingTasks?: PortalPendingTasks;
  recentEvents?: RecentPortalEvent[];
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
          client enters their email to receive a one-hour, single-use link: you
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

      {pendingTasks && (
        <div className="border-t border-neutral-100 pt-2 dark:border-neutral-900">
          <p className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
            Pending portal tasks
          </p>
          {pendingTasks.hasAny ? (
            <ul className="mt-1 flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-300">
              {pendingTasks.intakeIncomplete && (
                <li>&bull; Intake not yet submitted</li>
              )}
              {pendingTasks.consentToSignCount > 0 && (
                <li>
                  &bull; {pendingTasks.consentToSignCount} consent form
                  {pendingTasks.consentToSignCount === 1 ? "" : "s"} to sign
                </li>
              )}
              {pendingTasks.unreadMessageCount > 0 && (
                <li>
                  &bull; {pendingTasks.unreadMessageCount} unread portal message
                  {pendingTasks.unreadMessageCount === 1 ? "" : "s"}
                </li>
              )}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-neutral-500">
              No pending portal tasks.
            </p>
          )}
        </div>
      )}

      {recentEvents.length > 0 && (
        <div className="border-t border-neutral-100 pt-2 dark:border-neutral-900">
          <p className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
            Recent activity
          </p>
          <ul className="mt-1 flex flex-col gap-1 text-xs text-neutral-500">
            {recentEvents.map((e) => (
              <li key={e.id} className="flex justify-between gap-2">
                <span>{EVENT_LABELS[e.eventType] ?? e.eventType}</span>
                <span>
                  <FormattedDateTime iso={e.createdAt} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
