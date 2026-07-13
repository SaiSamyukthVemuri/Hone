// Read-only at-a-glance summary of the latest CONSULTATION note + latest
// SKIN/HAIR ANALYSIS note (migration 0126) for the appointment-prep briefing on
// the client profile overview. No forms — it links to the Consultation tab for
// the full dated history + add/revise. Server component; renders nothing
// interactive, so it is safe to include in the prep view.
//
// Practitioner-only. Must NOT be imported by any portal, public-booking,
// email, or SMS surface.

import Link from "next/link";
import type {
  ClinicalNoteKind,
  ClinicalNoteWithAuthor,
} from "@/lib/types/database";

type KindSummary = { latest: ClinicalNoteWithAuthor | null; total: number };

const KIND_LABEL: Record<ClinicalNoteKind, string> = {
  consultation: "Consultation notes",
  skin_hair_analysis: "Skin & hair analysis",
};

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function ClinicalNotesSummary({
  clientId,
  consultation,
  skinHair,
}: {
  clientId: string;
  consultation: KindSummary;
  skinHair: KindSummary;
}) {
  const rows: Array<{ kind: ClinicalNoteKind; data: KindSummary }> = [
    { kind: "consultation", data: consultation },
    { kind: "skin_hair_analysis", data: skinHair },
  ];

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800 md:p-5">
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-neutral-700 dark:text-neutral-300">
          Consultation &amp; skin/hair
        </h2>
        <Link
          href={`/clients/${clientId}?tab=consultation`}
          className="text-xs font-medium text-neutral-600 underline dark:text-neutral-300"
        >
          View / edit
        </Link>
      </header>
      <div className="flex flex-col gap-3">
        {rows.map(({ kind, data }) => (
          <div key={kind} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                {KIND_LABEL[kind]}
              </span>
              {data.latest && (
                <span className="text-[11px] text-neutral-500">
                  {formatDate(data.latest.occurred_at)}
                  {data.latest.author_name ? ` · ${data.latest.author_name}` : ""}
                </span>
              )}
            </div>
            {data.latest ? (
              <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm text-neutral-800 dark:text-neutral-200">
                {data.latest.body}
              </p>
            ) : (
              <p className="text-sm text-neutral-400">None recorded yet.</p>
            )}
            {kind === "skin_hair_analysis" &&
              data.latest &&
              data.latest.areas.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {data.latest.areas.map((area) => (
                    <span
                      key={area}
                      className="rounded-full bg-neutral-200 px-2 py-0.5 text-[11px] text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                    >
                      {area}
                    </span>
                  ))}
                </div>
              )}
            {data.total > 1 && (
              <span className="text-[11px] text-neutral-500">
                {data.total} entries
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
