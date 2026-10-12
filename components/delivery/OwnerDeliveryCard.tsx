import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { describeIncident, type OwnerIncident } from "@/lib/delivery/incidents";

// DELIVERY-VISIBILITY-02 — the studio owner's "Message delivery" card.
//
// Contract agreed with the #824 owner-console lane: a self-contained server
// component, mounted by one line, that reads owner_delivery_incidents (0215)
// with the signed-in user's OWN session. It renders nothing for anyone the
// database refuses (42501: another studio's owner, a practitioner, a front-desk
// user) or when the read fails, and it makes no provider call.
//
// It shows operational metadata only: which kind of message, how often, when,
// the latest appointment and what to do next. No client name, address, phone or
// message content, which the read does not return in the first place.

type Props = {
  studioId: string;
  /** IANA zone for the times shown. Optional; the contract is `studioId`. */
  timezone?: string | null;
};

function formatWhen(iso: string, timezone?: string | null): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone ?? undefined,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString();
  }
}

export async function OwnerDeliveryCard({ studioId, timezone }: Props) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("owner_delivery_incidents", { p_studio_id: studioId });
  if (error || !Array.isArray(data)) return null;

  const rows = data as OwnerIncident[];
  const open = rows.filter((r) => r.resolved_at === null);
  const emailEventsLive = Boolean(process.env.RESEND_WEBHOOK_SECRET);

  return (
    <section
      aria-labelledby="owner-delivery-heading"
      className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
    >
      <header className="flex flex-col gap-1">
        <h3 id="owner-delivery-heading" className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
          Message delivery
        </h3>
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          {open.length === 0
            ? "No delivery problems reported in the last 14 days."
            : `${open.length} open delivery ${open.length === 1 ? "problem" : "problems"}. Repeats of the same problem are counted, not listed again.`}
        </p>
        <p className="text-xs text-neutral-500">
          Shows what the email and text providers report back.
          {emailEventsLive
            ? " Delivered means the client's mail server or carrier accepted it, not that it was read."
            : " Email bounce reports are not switched on yet, so an email that bounces after sending will not appear here."}
        </p>
      </header>

      {open.length > 0 && (
        <ul className="flex flex-col gap-2">
          {open.map((row) => {
            const d = describeIncident(row);
            return (
              <li
                key={row.incident_id}
                className="flex flex-col gap-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950/30"
              >
                <p className="font-medium text-amber-900 dark:text-amber-100">
                  {d.title}
                  <span className="ml-2 text-xs font-normal">
                    {row.occurrences === 1 ? "once" : `${row.occurrences} times`}
                  </span>
                </p>
                <p className="text-xs text-amber-900/90 dark:text-amber-100/90">{d.meaning}</p>
                <p className="text-xs text-amber-900/90 dark:text-amber-100/90">
                  <span className="font-medium">Next step:</span> {d.nextStep}
                </p>
                <p className="text-xs text-neutral-600 dark:text-neutral-400">
                  Last {formatWhen(row.last_seen_at, timezone)}
                  {row.occurrences > 1 ? ` · first ${formatWhen(row.first_seen_at, timezone)}` : ""}
                  {row.last_appointment_id ? (
                    <>
                      {" · "}
                      <Link href={`/calendar/${row.last_appointment_id}`} className="underline">
                        latest appointment
                      </Link>
                    </>
                  ) : null}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
