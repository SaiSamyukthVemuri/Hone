// Clinical-notes EXPORT / PRINT view (migration 0126). Authenticated
// practitioner route only. It lives under app/(app) so the same studio-member
// auth + RLS that guards the profile guards this page. It is NOT reachable from
// the client portal, public booking, receipts, email, or SMS.
//
// Renders the two clinical record kinds as clearly-separate, dated sections with
// full attribution, area tags, and revision/superseded markers, in a layout
// optimised for print. No mutations; read-only.

import { notFound } from "next/navigation";
import Link from "next/link";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { getClientById } from "@/lib/supabase/queries";
import { getClinicalNotesForExport } from "@/lib/clinical-notes/queries";
import type { ClinicalNoteKind, ClinicalNoteWithAuthor } from "@/lib/types/database";
import { PrintButton } from "./print-button";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<ClinicalNoteKind, string> = {
  consultation: "Consultation notes",
  skin_hair_analysis: "Skin & hair analysis",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function sortNewestFirst(
  notes: ClinicalNoteWithAuthor[],
): ClinicalNoteWithAuthor[] {
  return [...notes].sort(
    (a, b) =>
      new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime() ||
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

export default async function ClinicalNotesPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { studio } = await getCurrentPractitionerWithStudio();
  const data = await getClientById(studio.id, id);
  if (!data) notFound();
  const { client } = data;

  const [consultation, skinHair] = await Promise.all([
    getClinicalNotesForExport(id, "consultation"),
    getClinicalNotesForExport(id, "skin_hair_analysis"),
  ]);
  const sections: Array<{ kind: ClinicalNoteKind; notes: ClinicalNoteWithAuthor[] }> = [
    { kind: "consultation", notes: sortNewestFirst(consultation) },
    { kind: "skin_hair_analysis", notes: sortNewestFirst(skinHair) },
  ];

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 print:px-0 print:py-0">
      <header className="flex items-start justify-between gap-4 border-b border-neutral-300 pb-4 print:border-black">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">Clinical notes: {client.name}</h1>
          <p className="text-xs text-neutral-500">
            {studio.name} · exported {formatDate(new Date().toISOString())}
          </p>
        </div>
        <div className="flex items-center gap-3 print:hidden">
          <Link
            href={`/clients/${id}?tab=consultation`}
            className="text-sm font-medium text-neutral-600 underline dark:text-neutral-300"
          >
            Back
          </Link>
          <PrintButton />
        </div>
      </header>

      {sections.map(({ kind, notes }) => (
        <section key={kind} className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-700 dark:text-neutral-300">
            {KIND_LABEL[kind]}
          </h2>
          {notes.length === 0 ? (
            <p className="text-sm text-neutral-500">No entries recorded.</p>
          ) : (
            <ul className="flex flex-col gap-4">
              {notes.map((note) => (
                <li
                  key={note.id}
                  className="break-inside-avoid border-b border-neutral-100 pb-3 dark:border-neutral-900"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                    <span className="text-sm font-medium">
                      {formatDate(note.occurred_at)}
                    </span>
                    <span className="text-[11px] text-neutral-500">
                      {note.author_name ?? "Unknown practitioner"}
                      {note.supersedes_note_id ? " · revision" : ""}
                      {note.is_superseded ? " · superseded" : ""}
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                    {note.body}
                  </p>
                  {kind === "skin_hair_analysis" && note.areas.length > 0 && (
                    <p className="mt-1 text-[11px] text-neutral-600 dark:text-neutral-400">
                      Areas: {note.areas.join(", ")}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
