"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import {
  errorDigest,
  safeErrorReference,
} from "@/lib/reliability/route-error-reference";

// REL-001. Last-resort boundary. Next.js renders this ONLY when an error
// escapes every nested error.tsx, which in practice means the root layout or a
// route-group layout threw. For the authenticated app that is a real path:
// app/(app)/layout.tsx runs requirePractitionerWithStudio() and
// listActiveStudioMemberships(), both of which throw on any Supabase error, and
// a segment's own layout sits OUTSIDE that segment's error.tsx. So the
// authenticated shell failing lands here, not in app/(app)/error.tsx.
//
// This used to render `<NextError statusCode={0} />`, the framework's built-in
// page, which is the uncontrolled failure REL-001 describes. It now renders a
// deliberate Hone screen.
//
// global-error replaces the entire document (it must supply <html> and <body>),
// so it cannot use the app shell and does not have the app's fonts or global
// stylesheet applied. The styling here is therefore inline and self-contained
// on purpose, and it must stay readable in that bare state.
//
// It also covers PUBLIC routes (marketing, token-bearing client links), so the
// copy stays environment-neutral: no "back to dashboard", no wording that
// assumes a signed-in practitioner.
//
// Reporting is UNCHANGED from the previous version: still an unconditional
// Sentry.captureException. This boundary is reached so rarely, and by errors
// whose server-side capture is least certain, that suppressing anything here
// would trade a real signal for a theoretical duplicate.

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  // Guarded read. This is the LAST boundary: if it throws on a non-object
  // thrown value, the user gets a blank document.
  const reference = safeErrorReference(errorDigest(error));

  useEffect(() => {
    // Guarded for the same reason the digest read is: this is the LAST
    // boundary, so nothing it does may be allowed to throw.
    try {
      Sentry.captureException(error);
    } catch {
      // Intentionally swallowed. See app/(app)/error.tsx.
    }
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          backgroundColor: "#FAFAF7",
          color: "#0A0A0A",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        }}
      >
        <main style={{ width: "100%", maxWidth: "440px" }}>
          <span
            style={{
              display: "inline-block",
              marginBottom: "28px",
              fontSize: "22px",
              fontWeight: 700,
              letterSpacing: "-0.02em",
            }}
          >
            Hone
          </span>
          <h1
            style={{
              margin: "0 0 16px",
              fontSize: "28px",
              fontWeight: 700,
              lineHeight: 1.1,
              letterSpacing: "-0.02em",
            }}
          >
            Something went wrong
          </h1>
          <p
            style={{
              margin: "0 0 12px",
              fontSize: "15px",
              lineHeight: 1.6,
              color: "#6B6B6B",
            }}
          >
            Hone could not finish loading this page. This is a problem on our
            side, not something you did.
          </p>
          <p
            style={{
              margin: "0 0 24px",
              fontSize: "15px",
              lineHeight: 1.6,
              color: "#6B6B6B",
            }}
          >
            Nothing was intentionally changed by this screen. If you were
            part-way through saving something, open the page again and check
            that it saved before you rely on it.
          </p>
          {/* A full reload is the only recovery available here: the failure was
              outside every route boundary, so there is no inner segment left to
              re-render. */}
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              padding: "10px 18px",
              fontSize: "14px",
              fontWeight: 500,
              color: "#FFFFFF",
              backgroundColor: "#0A0A0A",
              border: "1px solid #0A0A0A",
              borderRadius: "6px",
              cursor: "pointer",
            }}
          >
            Reload the page
          </button>
          {reference && (
            <p
              style={{
                margin: "24px 0 0",
                fontSize: "12px",
                fontVariantNumeric: "tabular-nums",
                color: "#6B6B6B",
              }}
              data-testid="global-error-reference"
            >
              Reference: {reference}
            </p>
          )}
        </main>
      </body>
    </html>
  );
}
