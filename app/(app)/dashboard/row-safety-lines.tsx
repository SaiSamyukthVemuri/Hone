import { CLINICAL_UNAVAILABLE_HEADLINE } from "@/components/clinical-unavailable-notice";

/**
 * The lines that must stay visible on the CLOSED Today row (Insurance D-1 / E-1), whatever else the
 * compact row folds into its details: every pinned note in full, the failed-read marker, and the
 * caution/watch line. Non-interactive spans only, because the row body is a link. Each adds only its own
 * height to the row.
 */
export function RowSafetyLines({
  pinnedNotes,
  unavailable,
  caution,
}: {
  pinnedNotes: ReadonlyArray<{ id: string; text: string }> | null;
  /** The Before-Today read for this row FAILED (not "nothing recorded"). */
  unavailable: boolean;
  /** The newest caution/watch text, already resolved by the caller from an answered read with history. */
  caution: string | null;
}) {
  return (
    <>
      {pinnedNotes && pinnedNotes.length > 0 && (
        /* EVERY pinned note, newest first. This used to render one truncated 50-character line, so a
           practitioner who pinned three notes saw one and could not tell the others were there. Each note
           is its own row and wraps rather than truncating: a pinned note is something the practitioner
           chose to keep in front of themselves, so hiding its second half defeats the point. `break-words`
           + `min-w-0` keep long notes from forcing the roster to scroll sideways on a phone. */
        <div className="mt-1 flex min-w-0 flex-col gap-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
            Pinned
          </span>
          <ul className="flex min-w-0 flex-col gap-0.5">
            {pinnedNotes.map((note) => (
              <li
                key={note.id}
                className="min-w-0 whitespace-pre-wrap break-words text-xs text-amber-800 dark:text-amber-300"
              >
                {note.text}
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* Insurance E-1: when the Before-Today read FAILED the compact row says so, in the profile's own
          words. Without it the absent caution line reads as "no caution", a clinical absence nobody read.
          Same truthfulness rule as the profile's "Unavailable". Not gated on history or caution. */}
      {unavailable && (
        <span data-testid="today-row-unavailable" className="mt-1 block text-xs text-neutral-500">
          {CLINICAL_UNAVAILABLE_HEADLINE}
        </span>
      )}
      {/* Insurance D-1: the caution/watch line, FULL text, wrapped, never inside the details. The caller
          passes null unless the read answered and there is history. */}
      {caution && (
        <span
          data-testid="today-row-caution"
          className="mt-1 block whitespace-pre-wrap break-words text-xs text-rose-900 dark:text-rose-200"
          title={caution}
        >
          Caution: {caution}
        </span>
      )}
    </>
  );
}
