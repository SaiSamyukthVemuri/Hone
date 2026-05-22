import Link from "next/link";

// Minimal footer for the in-app surfaces. Privacy + Terms links are
// required to be reachable from every authenticated page; this stays
// quiet at the bottom of the layout.
export function AppFooter() {
  return (
    <footer className="mt-16 border-t border-neutral-200 px-6 py-6 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-2">
        <span>© 2026 Sam Vemuri (operating as Hone)</span>
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          <Link
            href="/privacy"
            className="hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            Privacy
          </Link>
          <Link
            href="/terms"
            className="hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            Terms
          </Link>
          <a
            href="mailto:privacy@hone.care"
            className="hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            privacy@hone.care
          </a>
        </span>
      </div>
    </footer>
  );
}
