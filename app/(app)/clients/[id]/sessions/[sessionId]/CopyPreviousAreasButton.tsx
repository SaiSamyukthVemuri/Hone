// TEMPORARY CONTAINMENT — the whole-session "Copy areas and settings from last
// session" control is paused while it is upgraded to preserve complete settings
// safely (the previous version persisted real blocks before today's treatment
// was explicitly saved, which read as performed treatment). This renders a
// truthful, NON-INTERACTIVE notice — it does not call the server action. The
// in-form "Copy settings" control inside each treatment area is unaffected.
//
// This is a server component (no client interactivity) so it ships no action
// reference to the browser. When the migration-first whole-session draft
// workflow lands, this is replaced by the real prefill control.

export function CopyPreviousAreasButton() {
  return (
    <div
      role="status"
      className="flex flex-col gap-1 rounded-md border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300"
    >
      <span className="font-medium">Copy all areas from last session</span>
      <span className="text-neutral-600 dark:text-neutral-400">
        Temporarily unavailable while we upgrade it to preserve complete settings
        safely. You can still use <strong>Copy settings</strong> inside an
        individual treatment area.
      </span>
    </div>
  );
}
