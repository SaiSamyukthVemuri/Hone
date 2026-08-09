import Link from "next/link";
import { FormattedDateTime } from "@/components/formatted-date-time";
import type { ClinicalNoteWithAuthor } from "@/lib/types/database";

// Consultation + skin/hair notes, surfaced ON THE APPOINTMENT.
//
// WHY THIS EXISTS. Both note kinds already existed, already append-only,
// already revisable, already rendered on the client's Consultation tab — and
// Chloe could not find them. Nothing on the appointment she was about to work
// from mentioned them, and the tab that held them was named only
// "Consultation", so the skin/hair analysis was invisible twice over. This is a
// DISCOVERABILITY fix: it adds a link and a read-only summary. It writes
// nothing, owns no state, and introduces no second note model.
//
// Storage authority is unchanged: `client_clinical_notes`, kinds
// `consultation` and `skin_hair_analysis`, read through the existing
// getClinicalNotesSummary. Writing still happens only where it always did —
// the Consultation tab, through the existing clinical-note action. Recording a
// note from here would mean a second writer, so the CTA deliberately NAVIGATES
// rather than opening a form.
//
// TWO REASONS TO RENDER, deliberately different:
//
//   * the appointment IS a consultation → the primary CTA shows even when no
//     note exists yet, because that is exactly the visit where one is about to
//     be written. This is the G1 reachability gap.
//   * a note EXISTS for this client → the latest of each kind is shown before
//     the visit whatever the modality, because "what did we agree last time"
//     matters at every appointment. This is the G2 prep gap.
//
// When neither holds, the card renders NOTHING. An empty "no consultation
// notes" panel on every electrolysis appointment would be noise, and the
// practitioner already has the Consultation tab.

export type ConsultationNotesSummary = {
  consultation: { latest: ClinicalNoteWithAuthor | null; total: number };
  skin_hair_analysis: { latest: ClinicalNoteWithAuthor | null; total: number };
};

function NoteBlock({
  label,
  note,
  total,
  testId,
}: {
  label: string;
  note: ClinicalNoteWithAuthor;
  total: number;
  testId: string;
}) {
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        {label}
      </span>
      {/* The note body in full. No truncation: the shared point-of-care memory
          defines an excerpt contract for ITS card, and borrowing that here
          would silently shorten clinical text on a surface that has room for
          it. whitespace-pre-wrap preserves the practitioner's own line breaks;
          break-words stops a long unbroken token widening the layout. */}
      <p className="whitespace-pre-wrap break-words text-sm text-neutral-800 dark:text-neutral-200">
        {note.body}
      </p>
      <p className="text-xs text-neutral-500">
        <FormattedDateTime iso={note.occurred_at} />
        {note.author_name ? ` · ${note.author_name}` : ""}
        {/* Says plainly that this is the CURRENT entry of several, so the card
            never reads as the whole record. Full history stays on the tab. */}
        {total > 1 ? ` · latest of ${total}` : ""}
      </p>
    </div>
  );
}

export function ConsultationNotesCard({
  clientId,
  isConsultation,
  summary,
}: {
  clientId: string | null;
  // The appointment's authoritative SERVICE modality, resolved by the caller.
  isConsultation: boolean;
  summary: ConsultationNotesSummary | null;
}) {
  if (!clientId) return null;

  const consultation = summary?.consultation.latest ?? null;
  const skinHair = summary?.skin_hair_analysis.latest ?? null;
  const hasAnyNote = !!consultation || !!skinHair;

  // Nothing to say and nothing to prompt: render nothing at all.
  if (!isConsultation && !hasAnyNote) return null;

  const href = `/clients/${clientId}?tab=consultation`;

  return (
    <section
      data-testid="appointment-consultation-notes"
      className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 text-sm dark:border-neutral-800"
    >
      <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        Consultation &amp; skin/hair
      </h2>

      {hasAnyNote ? (
        <div className="flex flex-col gap-4">
          {consultation && (
            <NoteBlock
              label="Consultation note"
              note={consultation}
              total={summary!.consultation.total}
              testId="appointment-consultation-note"
            />
          )}
          {skinHair && (
            <NoteBlock
              label="Skin/hair analysis"
              note={skinHair}
              total={summary!.skin_hair_analysis.total}
              testId="appointment-skin-hair-note"
            />
          )}
        </div>
      ) : (
        <p className="text-neutral-500">
          No consultation or skin/hair notes recorded for this client yet.
        </p>
      )}

      {/* Consultation appointments get the PRIMARY action — this is the visit
          where the note gets written, and having to know a tab exists was the
          whole problem. Other appointments get a quiet link so the same
          material is one tap away without competing with Chart session. */}
      <Link
        href={href}
        data-testid={
          isConsultation
            ? "appointment-record-consultation-notes"
            : "appointment-view-consultation-notes"
        }
        className={
          isConsultation
            ? "min-h-[44px] self-start rounded-md border border-neutral-900 bg-neutral-900 px-3 py-2.5 text-xs font-medium text-white hover:bg-neutral-800 dark:border-white dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            : "self-start text-xs font-medium text-neutral-700 underline underline-offset-2 hover:text-neutral-900 dark:text-neutral-300"
        }
      >
        {isConsultation
          ? "Record consultation notes"
          : hasAnyNote
            ? "View all consultation & skin/hair notes"
            : "Open consultation & skin/hair"}
      </Link>
    </section>
  );
}
