import type { ReactNode } from "react";

// CLIN-01-B. THE one "we could not read this client's clinical history"
// surface on the client profile.
//
// It exists because four profile cards make AFFIRMATIVE statements about
// charted history ("No recorded visits yet.", "No charted treatments yet.",
// "No charted treatment history yet.", "No watch or plan notes recorded from
// the last treatment.") and a failed session_blocks read used to reach every
// one of them as an empty array. A practitioner cannot tell a query timeout
// from a first-visit client by looking, so the two must not render the same.
//
// The distinction is the one lib/sessions/last-treatment-loader.ts already
// defines and documents: selected / none / UNAVAILABLE. This is the
// presentation half of `unavailable`, and it deliberately reuses the copy and
// the amber dashed styling of the appointment page's existing unavailable
// surface (LastTreatmentSection in app/(app)/calendar/[id]/page.tsx) rather
// than inventing a second voice for the same fact.
//
// It is NOT a client state. It says nothing about the client; it says
// something about this page load.

export const CLINICAL_UNAVAILABLE_HEADLINE =
  "Clinical history could not be loaded.";

export function ClinicalUnavailableNotice({
  testId,
  children,
}: {
  testId: string;
  // Anything that DID load and is still worth showing underneath. Never a
  // clinical absence.
  children?: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className="rounded-lg border border-dashed border-amber-300 px-5 py-4 text-sm text-amber-900 dark:border-amber-800 dark:text-amber-200"
    >
      <p>{CLINICAL_UNAVAILABLE_HEADLINE}</p>
      <p className="mt-1.5 text-xs">
        This is not a statement that none is recorded. Reload before treating,
        and open the session record directly if you need it now.
      </p>
      {children}
    </div>
  );
}
