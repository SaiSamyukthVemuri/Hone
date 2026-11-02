import type { ReactNode } from "react";

// The heading of one focused Settings view (R2). Every rail item is its own
// route and opens here, at the top. The shell moves keyboard focus to the
// element marked data-settings-heading when the route changes (preventScroll,
// never into a field), so a screen-reader user lands on the view's name.
//
// `scope` states who the view applies to, replacing the old Personal/Studio
// overlines: studio-wide views say "Applies to the whole studio.".

export const STUDIO_WIDE_SCOPE = "Applies to the whole studio.";
export const STUDIO_WIDE_SCOPE_SHORT = "Whole studio";

export function SettingsViewHeading({
  title,
  scope,
  children,
}: {
  title: string;
  scope?: string;
  children?: ReactNode;
}) {
  return (
    <header data-view-head>
      {/* As in the approved settings artifact: the view name with its scope as a
          chip beside it. */}
      {/* Phone: the title and the chip share ONE row (a grid) and the title wraps
          inside its own column, so the chip never adds a line between the title
          and the view. From sm up they flow as a wrapping row. */}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 sm:flex sm:flex-wrap sm:items-center sm:justify-between sm:gap-y-1">
        <h2
          tabIndex={-1}
          data-settings-heading
          className="scroll-mt-32 text-xl font-medium outline-none"
        >
          {title}
        </h2>
        {scope && (
          // On a phone the full sentence would not fit beside the title and would
          // wrap to its own line, adding a line of height between the title and the
          // view. There the studio-wide chip reads "Whole studio"; from sm up it is
          // the full sentence (only one of the two is ever displayed).
          <span className="rounded-full border border-neutral-300 px-2.5 py-0.5 text-xs font-medium text-neutral-700 dark:border-neutral-700 dark:text-neutral-300">
            {scope === STUDIO_WIDE_SCOPE ? (
              <>
                <span className="sm:hidden">{STUDIO_WIDE_SCOPE_SHORT}</span>
                <span className="hidden sm:inline">{scope}</span>
              </>
            ) : (
              scope
            )}
          </span>
        )}
      </div>
      {children && <p className="mt-1 text-sm text-neutral-500">{children}</p>}
    </header>
  );
}

export function OwnerOnlyNotice({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
      {children}
    </div>
  );
}
