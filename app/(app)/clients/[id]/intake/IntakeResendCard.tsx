"use client";

import { useState, useTransition } from "react";
import type { IntakeLinkStatus } from "@/lib/intake/link-status";
import { getIntakeLinkAction, resendIntakeEmailAction } from "./actions";

type Props = {
  clientId: string;
  // The CURRENT in-progress intake row. Resend refreshes the link for
  // THIS row (preserving saved answers). It never creates a new intake.
  intakeId: string;
  clientHasEmail: boolean;
  // Best-effort hint only: true when this in-progress intake is older than
  // the 14-day link TTL, so the last link the client received has likely
  // expired. Computed server-side from started_at; NOT precise tracking.
  // Now used only as the LEGACY fallback (rows with no stored metadata yet).
  linkMaybeExpired: boolean;
  // Precise smart status computed server-side from the migration-0097 display
  // metadata (last sent, expiry, days left, send count). When present and not
  // usingFallback, it drives the status copy + the CTA label.
  status: IntakeLinkStatus;
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// PR #293. Prominent, primary "Resend intake link" CTA on the client
// Health & Forms tab, shown for an in-progress intake. This is a
// discoverability fix over existing safe backend behaviour: it reuses
// resendIntakeEmailAction (mints a fresh 14-day link for the SAME intake
// row and re-emails it, keeping any answers the client already saved) and
// getIntakeLinkAction (copy-link fallback). It deliberately does NOT call
// requestIntakeUpdateAction, that starts a brand-new blank intake.
export function IntakeResendCard({
  clientId,
  intakeId,
  clientHasEmail,
  linkMaybeExpired,
  status,
}: Props) {
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function resend() {
    const fd = new FormData();
    fd.set("client_id", clientId);
    fd.set("intake_id", intakeId);
    setError(null);
    setSent(false);
    startTransition(async () => {
      const res = await resendIntakeEmailAction(fd);
      if (!res.ok) {
        // Generic message, never surface a token / provider detail.
        setError("Could not send the intake link. Please try again.");
        return;
      }
      setSent(true);
      setTimeout(() => setSent(false), 3000);
    });
  }

  function fetchLink() {
    const fd = new FormData();
    fd.set("client_id", clientId);
    fd.set("intake_id", intakeId);
    setError(null);
    startTransition(async () => {
      const res = await getIntakeLinkAction(fd);
      if (!res.ok) {
        setError("Could not generate the intake link. Please try again.");
        return;
      }
      setLink(res.intakeUrl);
    });
  }

  function copy() {
    if (!link) return;
    void navigator.clipboard.writeText(link).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setError("Copy failed. Select and copy the link manually."),
    );
  }

  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-950">
      <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
        Resend intake link
      </h2>

      {/* Legacy fallback (rows minted before migration 0097 stored metadata):
          hedge with the started_at heuristic. Once a fresh link is issued the
          precise status below takes over. */}
      {status.usingFallback && linkMaybeExpired && (
        <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
          The previous link may have expired. Resend a fresh link so the client
          can continue.
        </p>
      )}

      {/* Precise smart status (stored metadata). Expiry/close-to-expiry drive a
          prominent "send a fresh link" prompt. */}
      {!status.usingFallback && status.state === "expired" && (
        <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
          This intake link has likely expired. Send a fresh link.
        </p>
      )}
      {!status.usingFallback && status.state === "closeToExpiry" && (
        <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
          This intake link expires soon. Send a fresh link so the client can
          continue.
        </p>
      )}

      {!status.usingFallback && (
        <div className="mt-3 space-y-0.5 text-sm text-neutral-600 dark:text-neutral-400">
          <p>
            {status.lastSentAt
              ? `Intake link emailed ${fmtDateTime(status.lastSentAt)}`
              : "Not emailed yet: use Copy link to share it."}
            {status.sendCount >= 2 ? ` · sent ${status.sendCount} times` : ""}
          </p>
          {status.state !== "expired" && (
            <p>
              Current link expires {fmtDate(status.expiresAt)} ·{" "}
              {status.daysLeft} {status.daysLeft === 1 ? "day" : "days"} left
            </p>
          )}
          <p>Client has not submitted yet.</p>
        </div>
      )}

      <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">
        Sends the client a fresh secure link and keeps any answers they&apos;ve
        already saved. Links expire after 14 days.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={resend}
          disabled={isPending || !clientHasEmail}
          title={clientHasEmail ? undefined : "No email on file for this client"}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {isPending ? "Sending…" : status.buttonLabel}
        </button>
        <button
          type="button"
          onClick={fetchLink}
          disabled={isPending}
          className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:hover:bg-neutral-900"
        >
          {link ? "Regenerate link" : "Copy link"}
        </button>
        {link && (
          <button
            type="button"
            onClick={copy}
            disabled={isPending}
            className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-950 dark:hover:bg-neutral-900"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>

      {!clientHasEmail && (
        <p className="mt-2 text-xs text-neutral-500">
          No email on file. Use Copy link to share it manually.
        </p>
      )}

      {link && (
        <p className="mt-2 break-all text-[11px] text-neutral-500">{link}</p>
      )}
      {sent && <p className="mt-2 text-xs text-emerald-700">Intake link sent.</p>}
      {error && (
        <p className="mt-2 text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
