import Link from "next/link";
import { TEXT_LINK_FEEDBACK } from "@/components/ui/control-base";

// Minimal footer for the in-app surfaces. Privacy + Terms links are
// required to be reachable from every authenticated page; this stays
// quiet at the bottom of the layout.
export function AppFooter() {
  return (
    <footer className="mt-16 border-t border-neutral-200 px-6 py-6 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-2">
        <span>© 2026 Hone</span>
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          <Link
            href="/privacy"
            className={TEXT_LINK_FEEDBACK}
          >
            Privacy
          </Link>
          <Link
            href="/terms"
            className={TEXT_LINK_FEEDBACK}
          >
            Terms
          </Link>
          <a
            href="mailto:privacy@hone.care"
            className={TEXT_LINK_FEEDBACK}
          >
            privacy@hone.care
          </a>
        </span>
      </div>
    </footer>
  );
}
