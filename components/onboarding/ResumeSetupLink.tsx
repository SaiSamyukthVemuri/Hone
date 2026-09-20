"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

// ---------------------------------------------------------------------------
// RESUME SETUP.
//
// THE GAP THIS CLOSES. `nextSetupStep` made the next task discoverable FROM the
// checklist, and stopped there. Every settings completion path ends in
// `revalidatePath` and none redirects (12 action files, checked), so an
// operator who followed "Continue setup", completed the task and saved simply
// STAYED on that settings page — no indication of what came next, which is the
// post-completion half of the pilot feedback and exactly what review caught.
//
// WHY A QUERY FLAG AND NOT A REDIRECT. Returning the operator automatically
// would mean editing all twelve action files to redirect conditionally,
// changing the behaviour of every ordinary settings save for a setup-only
// case. This carries the setup context in the URL instead: the flag survives a
// server-action save because `revalidatePath` re-renders the same URL, so the
// way back is still on screen after the task is done.
//
// IT IS A WAY BACK, NOT A REDIRECT. Nothing is forced; an operator who wandered
// in from setup can ignore it and keep working. Rendering nothing without the
// flag means ordinary settings navigation is untouched.
//
// KNOWN LIMIT, stated rather than hidden: a settings surface that navigates
// client-side without preserving the query string drops the flag, and the way
// back disappears. That is a best-effort affordance, not a guarantee, and it is
// why the checklist itself remains the authority on what is outstanding.
// ---------------------------------------------------------------------------

export const RESUME_SETUP_PARAM = "setup";

export function ResumeSetupLink() {
  const params = useSearchParams();
  if (params.get(RESUME_SETUP_PARAM) !== "1") return null;

  return (
    <Link
      href="/getting-started"
      className="inline-flex min-h-11 items-center self-start rounded-md border border-neutral-300 px-4 text-sm font-medium text-neutral-900 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-100 dark:hover:bg-neutral-800"
    >
      ← Back to setup
    </Link>
  );
}
