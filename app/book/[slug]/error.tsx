"use client";

import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import * as Sentry from "@sentry/nextjs";
import { MarketingFooter } from "@/app/_components/MarketingFooter";
import { MARKETING_PALETTE as PALETTE } from "@/app/_components/marketingNav";
import { EyebrowCaption } from "@/app/_components/MarketingAtoms";
import { FOCUS_RING } from "@/components/ui/control-base";
import {
  errorDigest,
  safeErrorReference,
  shouldReportRouteErrorFromClient,
} from "@/lib/reliability/route-error-reference";

// SENTRY-BOOKING-ERR-01. The public booking page's own error boundary.
//
// What lands here
// ---------------
// Every failure inside /book/[slug] that is not notFound() or redirect():
//
//   * a READ the page could not complete. getStudioBySlug throws when the
//     studio row cannot be read (a transport failure surfaces as
//     "Failed to load studio: TypeError: fetch failed") and returns null only
//     when the read succeeded and found nothing. The page keeps those apart:
//     null is notFound() and a 404, a failed read is thrown and arrives HERE
//     with a 500. An unreadable studio is UNKNOWN, never "does not exist".
//   * a Server Action the booking form awaits inside a transition (slot fetch,
//     next available day, the booking itself). React 19 rethrows a rejected
//     transition into the nearest boundary, which also covers a stale tab whose
//     action id a newer deployment no longer recognises.
//
// Before this file existed all of it escaped to app/global-error.tsx, which
// replaces the whole document with an unstyled last-resort screen.
//
// What may be shown
// -----------------
// Fixed copy only. `error.message` and `error.stack` are NEVER rendered: loader
// messages carry raw PostgREST text. The only variable text is the digest, and
// only after safeErrorReference has validated its shape (REL-014). Nothing about
// the studio is shown, because the studio is exactly what may have failed to
// load, and this boundary loads nothing itself.
//
// What is NOT promised
// --------------------
// A booking action that throws also surfaces here, possibly after the
// appointment was written. So the copy never says nothing happened; it tells a
// visitor who had just pressed Book to check before booking again, which is
// what stands between a lost response and a double booking.
//
// Reporting follows the authenticated boundary exactly: a server-raised error
// is already captured by onRequestError in instrumentation.ts, so only an
// error raised in the browser (no digest) is reported from here.

export default function PublicBookingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  const [retrying, startRetry] = useTransition();
  // errorDigest, not error.digest: React can hand a boundary a thrown non-object.
  const reference = safeErrorReference(errorDigest(error));

  useEffect(() => {
    if (!shouldReportRouteErrorFromClient(error)) return;
    try {
      Sentry.captureException(error);
    } catch {
      // Reporting must never be able to break the screen that is already
      // handling a failure. See app/(app)/error.tsx.
    }
  }, [error]);

  // router.refresh() re-requests the page from the server and reset() lets the
  // fresh payload render; reset() alone would re-render the payload that already
  // failed. Inside a transition so the press is acknowledged until it lands.
  function retry() {
    startRetry(() => {
      router.refresh();
      reset();
    });
  }

  return (
    <main
      style={{
        backgroundColor: PALETTE.bg,
        color: PALETTE.ink,
        fontFeatureSettings: '"cv11"',
      }}
      className="min-h-screen font-[var(--font-inter)]"
      data-testid="public-booking-error-boundary"
    >
      <section className="px-6 py-20 md:px-12 lg:px-16">
        <div className="mx-auto max-w-[760px] flex flex-col gap-10">
          <div>
            <EyebrowCaption>Book an appointment</EyebrowCaption>
            <h1
              className="font-[var(--font-fraunces)] mt-8 text-[36px] font-bold leading-[1.05] md:text-[48px]"
              style={{ letterSpacing: "-0.03em" }}
            >
              Booking is unavailable right now
            </h1>
            <p className="mt-6 max-w-[560px] text-[17px] leading-[1.6]">
              This booking page could not finish loading. This is a problem on
              our side, not something you did. Please try again in a moment.
            </p>
            <p
              className="mt-4 max-w-[560px] text-[15px] leading-[1.6]"
              style={{ color: PALETTE.muted }}
            >
              If you had just pressed Book, your appointment may already be
              booked. Check your email for a confirmation, or contact the
              studio, before you book again.
            </p>
          </div>

          <div>
            <button
              type="button"
              onClick={retry}
              disabled={retrying}
              aria-busy={retrying}
              className={`min-h-[44px] px-8 py-4 text-[14px] font-medium uppercase disabled:opacity-50 ${FOCUS_RING}`}
              style={{
                backgroundColor: PALETTE.ink,
                color: PALETTE.bg,
                letterSpacing: "0.1em",
              }}
            >
              {retrying ? "Trying again…" : "Try again"}
            </button>
          </div>

          {reference && (
            <p
              className="text-[12px] tabular-nums"
              style={{ color: PALETTE.muted }}
              data-testid="public-booking-error-reference"
            >
              Reference: {reference}
            </p>
          )}
        </div>
      </section>
      <MarketingFooter />
    </main>
  );
}
