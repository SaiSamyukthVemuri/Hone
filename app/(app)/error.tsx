"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { startTransition, useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import {
  errorDigest,
  safeErrorReference,
  shouldReportRouteErrorFromClient,
} from "@/lib/reliability/route-error-reference";

// REL-001. The authenticated app's shared error boundary.
//
// Scope of this boundary
// ----------------------
// Next.js nests a segment's `error.tsx` INSIDE that segment's `layout.tsx`
// (createComponentTree passes the segment's error component to the LayoutRouter
// that renders the segment's CHILDREN). So this file contains every page and
// every nested layout under app/(app)/: dashboard, clients, calendar, records,
// notifications, getting-started and the whole settings subtree. That makes it
// the narrowest boundary shared by all of them.
//
// It deliberately does NOT contain app/(app)/layout.tsx itself. A throw in the
// app shell (its requirePractitionerWithStudio / listActiveStudioMemberships
// reads) bubbles past this boundary to app/global-error.tsx, which is why that
// file is also a deliberate Hone screen rather than the stock Next.js one.
//
// Before this existed, every one of those failures fell through to
// global-error.tsx and rendered Next's bare built-in error page: no Hone
// framing, no retry, no navigation, no support reference.
//
// What may be shown
// -----------------
// `error.message` is NEVER rendered. Loaders across lib/ throw messages built
// from raw PostgREST/Supabase text (`Failed to load clients: ${error.message}`
// and 77 others like it), so the message is an untrusted, potentially
// identifier-bearing string. `error.stack` is never rendered either. The copy
// below is fixed, and the only variable text is a validated digest.
//
// What is NOT promised
// --------------------
// A Server Action that throws also surfaces here, so this boundary cannot claim
// that nothing was written. The copy says only what the boundary itself
// guarantees (it changed nothing) and tells the practitioner to re-check any
// save that was in flight.

export default function AuthenticatedAreaError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  // errorDigest, not error.digest: the declared prop type is a compile-time
  // convenience and React really can hand a boundary a thrown null/string.
  const reference = safeErrorReference(errorDigest(error));

  useEffect(() => {
    // Server-side failures are already captured by onRequestError in
    // instrumentation.ts. Only browser-raised errors are reported from here.
    // See shouldReportRouteErrorFromClient for the full reasoning.
    if (!shouldReportRouteErrorFromClient(error)) return;
    try {
      Sentry.captureException(error);
    } catch {
      // Reporting must never be able to break the screen that is already
      // handling a failure. A hostile or exotic thrown value can make
      // serialization throw; losing that one report is strictly better than
      // losing the recovery UI.
    }
  }, [error]);

  // reset() alone only clears this boundary's state and re-renders the same
  // already-rejected server payload, so a server-rendered failure would
  // immediately re-throw and the button would look broken. router.refresh()
  // re-requests the failed segment from the server; reset() then lets the fresh
  // payload render. Both are needed, in that order.
  function retry() {
    startTransition(() => {
      router.refresh();
      reset();
    });
  }

  return (
    <div className="mx-auto max-w-xl py-6" data-testid="route-error-boundary">
      <h1 className="text-2xl font-semibold tracking-tight">
        Something went wrong
      </h1>
      <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">
        Hone could not finish loading this page. This is a problem on our side,
        not something you did.
      </p>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
        Nothing was intentionally changed by this screen. If you were part-way
        through saving something, open the page again and check that it saved
        before you rely on it.
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={retry}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          Try again
        </button>
        <Link
          href="/dashboard"
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Go to Dashboard
        </Link>
      </div>

      {/* The reference block reuses the PR #402 amendment-path idiom: a
          role="alert" panel whose reference line is rendered ONLY when an id
          exists, so an absent digest produces no line at all rather than an
          empty or "undefined" one. */}
      {reference && (
        <div
          role="alert"
          tabIndex={-1}
          className="mt-5 rounded-md border-2 border-red-400 bg-red-50 p-3 text-sm text-red-900 outline-none dark:border-red-700 dark:bg-red-950/40 dark:text-red-200"
        >
          <p className="font-semibold">If you contact support</p>
          <p className="mt-0.5">
            Give them this reference so they can find the matching server log.
          </p>
          <p
            className="mt-1 text-xs tabular-nums text-red-800/80 dark:text-red-300/80"
            data-testid="route-error-reference"
          >
            Reference: {reference}
          </p>
        </div>
      )}
    </div>
  );
}
