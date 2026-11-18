import Link from "next/link";
import { FormattedDateTime } from "@/components/formatted-date-time";

// HON-10: the "From last visit, for today" band. The note names the visit it was WRITTEN at (that visit's date, and a link to that exact session), because
// the "Last treatment" card beside it follows a different rule (the newest CHARTED session) and the two can come from different visits.
export function FromLastVisitBand({
  note,
  session,
  clientId,
}: {
  note: string;
  session: { id: string; startedAt: string } | null;
  clientId: string;
}) {
  return (
    <section className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm dark:border-blue-900 dark:bg-blue-950/40">
      <h2 className="text-xs font-medium uppercase tracking-wider text-blue-800 dark:text-blue-300">
        From last visit, for today
      </h2>
      {session && (
        <p data-testid="from-last-visit-identity" className="mt-0.5 text-xs text-blue-800 dark:text-blue-300">
          Written at the visit on <FormattedDateTime iso={session.startedAt} format="date" />
          {" · "}
          <Link
            href={`/clients/${encodeURIComponent(clientId)}/sessions/${encodeURIComponent(session.id)}`}
            data-testid="from-last-visit-link"
            className="font-medium underline underline-offset-2"
          >
            Open that visit
          </Link>
        </p>
      )}
      <p className="mt-1.5 whitespace-pre-wrap text-blue-950 dark:text-blue-100">{note}</p>
    </section>
  );
}
