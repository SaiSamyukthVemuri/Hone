import { FormattedDateTime } from "@/components/formatted-date-time";
import type { PrepNarrativeRenderItem } from "@/lib/sessions/appointment-prep-memory";

// Practitioner narrative recovered from a visit OTHER than the treatment shown
// above it, rendered with its provenance intact.
//
// Extracted verbatim from app/(app)/calendar/[id]/page.tsx so the calendar
// preview drawer can render the same items the appointment detail page does,
// rather than growing a second opinion about how a prior note should be
// attributed. WHICH items are external, and their chronology, is decided by
// buildPrepProvenanceModel — this component only paints the answer, and
// deliberately makes no chronology judgement of its own.
//
// No "use client" directive: it holds no state, so it renders in a Server
// Component (the detail page) and inside a Client Component (the drawer)
// alike. FormattedDateTime is already a client component and carries its own.
export function PriorNarrative({ items }: { items: PrepNarrativeRenderItem[] }) {
  if (items.length === 0) return null;
  return (
    <div data-testid="prep-prior-narrative" className="flex flex-col gap-3">
      {items.map((item) => (
        <div
          key={item.key}
          data-testid={
            item.source === "next_session_note"
              ? "prep-prior-plan"
              : "prep-prior-legacy-notes"
          }
          className={
            item.source === "next_session_note"
              ? "rounded-md border border-blue-200 bg-blue-50 px-4 py-3 dark:border-blue-900 dark:bg-blue-950/40"
              : ""
          }
        >
          <p
            className={
              item.source === "next_session_note"
                ? "text-[11px] font-semibold uppercase tracking-wider text-blue-800 dark:text-blue-300"
                : "text-[11px] font-medium uppercase tracking-wider text-neutral-500"
            }
          >
            {item.label}
          </p>
          {/* PROVENANCE. Every fallback item is dated, because it may come from
              a different visit than anything shown above it. A session id is
              never rendered: the date is the practitioner-meaningful handle. */}
          {/* PROVENANCE, in BOTH directions. Rendering a date only for the
              "after" case left an OLDER plan silently undated, and that silence
              read as "written at the treatment above", inverting the status of
              an instruction that may already have been carried out. Chronology
              is the ONLY relationship the data supports: a claim about whether
              an instruction still stands would be an inference Hone cannot
              make. See buildPrepProvenanceModel. */}
          <p
            data-testid="prep-prior-date"
            className={
              item.source === "next_session_note"
                ? "text-xs text-blue-800 dark:text-blue-300"
                : "text-xs text-neutral-500"
            }
          >
            <FormattedDateTime iso={item.startedAt} format="date" />
            {item.chronology === "after_selected_treatment"
              && ", after the treatment above"}
            {item.chronology === "before_selected_treatment"
              && ", before the treatment above"}
          </p>
          <p
            className={
              item.source === "next_session_note"
                ? "mt-0.5 whitespace-pre-wrap break-words text-sm text-blue-950 dark:text-blue-100"
                : "mt-0.5 whitespace-pre-wrap break-words text-sm text-neutral-700 dark:text-neutral-300"
            }
          >
            {item.text}
          </p>
        </div>
      ))}
    </div>
  );
}
