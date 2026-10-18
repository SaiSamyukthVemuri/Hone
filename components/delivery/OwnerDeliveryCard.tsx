import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { describeIncident, type OwnerIncident } from "@/lib/delivery/incidents";
import { concernLabel, ledgerStatusWords } from "@/lib/delivery/concerns";

type OwnerConcern = {
  concern_id: string;
  appointment_id: string;
  channel: string;
  purpose: string;
  ledger_status_at_report: string;
  reported_at: string;
  state: string;
};

// DELIVERY-VISIBILITY-02 — the studio owner's "Message delivery" card.
//
// Contract agreed with the #824 owner-console lane: a self-contained server
// component, mounted by one line, that reads owner_delivery_incidents (0215)
// with the signed-in user's OWN session. It renders nothing ONLY for someone the
// database refuses (42501: another studio's owner, a practitioner, a front-desk
// user). Any other failure is shown to the owner as UNAVAILABLE: a read that
// failed must never look like "no problems". It makes no provider call.
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
  let data: unknown = null;
  let errorCode: string | null = null;
  let failed = false;
  let concerns: OwnerConcern[] | null = null;
  try {
    const supabase = await createClient();
    const [res, concernsRes] = await Promise.all([
      supabase.rpc("owner_delivery_incidents", { p_studio_id: studioId }),
      supabase.rpc("owner_delivery_concerns", { p_studio_id: studioId }),
    ]);
    data = res.data;
    concerns = Array.isArray(concernsRes.data) ? (concernsRes.data as OwnerConcern[]) : null;
    if (res.error) {
      failed = true;
      errorCode = typeof res.error.code === "string" ? res.error.code : null;
    } else if (concernsRes.error) {
      failed = true;
    }
  } catch {
    failed = true;
  }
  // Not this studio's owner: the card does not exist for them.
  if (errorCode === "42501") return null;
  if (failed || !Array.isArray(data)) return <DeliveryStatusUnavailable />;

  const rows = data as OwnerIncident[];
  const open = rows.filter((r) => r.resolved_at === null);
  const allConcerns = concerns ?? [];
  const openConcerns = allConcerns.filter((c) => c.state === "open");
  // A CLOSED CONCERN WAS STILL A REPORTED PROBLEM (Codex P2 4307695801).
  // `owner_delivery_concerns` returns the last 14 days, so a concern the studio
  // raised and then closed was dropped from every count — and the card then said
  // "No delivery problems reported in the last 14 days" about a fortnight that
  // held one. I had previously PINNED that as a deliberate asymmetry, on the
  // reasoning that the card does not LIST closed concerns so counting them would
  // reference something invisible. The reviewer is right that denying the report
  // is the worse error: the fix is to acknowledge it in words, not to leave the
  // denial standing.
  const closedConcerns = allConcerns.filter((c) => c.state !== "open");
  // Capped the same way as the incidents read — `owner_delivery_concerns`
  // applies `limit 200` (0221:357) — so its counts are counts of what is SHOWN.
  const OWNER_CONCERN_CAP = 200;
  const concernsTruncated = allConcerns.length >= OWNER_CONCERN_CAP;
  const resolvedCount = rows.length - open.length;

  // EVERY CATEGORY THIS CARD CAN REPORT, IN ONE PLACE, and the summary claim is
  // derived from it rather than from a subset.
  //
  // That claim has now been wrong TWICE for the same reason: it read fewer
  // categories than the card displays. First it ignored RESOLVED incidents
  // (Codex P2 4244957358); then it ignored OPEN CONCERNS and printed "No
  // delivery problems reported in the last 14 days" directly above a list of
  // them (Codex P2 4307428928). Adding `openConcerns` to the old condition
  // would have been the third instance waiting to happen, so the counts are
  // enumerated here and the sentences below consult ONLY these derived
  // booleans. A fourth category is added to this object, and the claim follows.
  const reportedCounts = {
    openIncidents: open.length,
    resolvedIncidents: resolvedCount,
    openConcerns: openConcerns.length,
    // The fourth category, added exactly where the comment above said a fourth
    // would go (Codex P2 4307695801).
    closedConcerns: closedConcerns.length,
  };
  const anythingReported = Object.values(reportedCounts).some((n) => n > 0);
  const anythingOpen = reportedCounts.openIncidents + reportedCounts.openConcerns > 0;

  // THIS READ IS CAPPED, SO ITS COUNTS DESCRIBE WHAT IS SHOWN (Codex P2
  // 4307695060). `owner_delivery_incidents` applies `limit 200`
  // (supabase/migrations/0215_delivery_incidents.sql:314) after ordering open
  // incidents first, so a studio at the cap sees a SLICE: older open incidents
  // are absent, and because resolved rows sort LAST they are the first thing
  // the cap removes — which would also distort `resolvedCount` silently.
  //
  // The cap is mirrored here rather than derived, because the function does not
  // report it; the test pins this exact number so a divergence from 0215 fails
  // rather than drifts.
  const OWNER_INCIDENT_CAP = 200;
  const incidentsTruncated = rows.length >= OWNER_INCIDENT_CAP;
  // Mirrors `resolvedNote` for concerns, so a fortnight holding only a CLOSED
  // concern says what happened instead of denying it.
  const closedConcernNote =
    closedConcerns.length === 0
      ? ""
      : ` ${closedConcerns.length} ${closedConcerns.length === 1 ? "report" : "reports"} from your studio ${closedConcerns.length === 1 ? "was" : "were"} closed in the last 14 days.`;
  const resolvedNote =
    resolvedCount === 0
      ? ""
      : ` ${resolvedCount} ${resolvedCount === 1 ? "problem was" : "problems were"} reported in the last 14 days and since resolved.`;

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
          {!anythingReported
            ? "No delivery problems reported in the last 14 days."
            : !anythingOpen
              ? `No open delivery problems.${resolvedNote}${closedConcernNote}`
              : open.length === 0
                ? `${openConcerns.length} open ${openConcerns.length === 1 ? "report" : "reports"} from your studio.${resolvedNote}`
                : `${open.length} open delivery ${open.length === 1 ? "problem" : "problems"} shown. Repeats of the same problem are counted, not listed again.${resolvedNote}`}
        </p>
        {incidentsTruncated && (
          <p className="text-xs text-amber-800 dark:text-amber-300">
            Showing the most recent {OWNER_INCIDENT_CAP} incidents. Older incidents are not listed.
          </p>
        )}
        <p className="text-xs text-neutral-500">
          {/* Never infers that bounce reporting is live: a stored signing secret is
              not a configured, tested endpoint (Codex P2 4253217747), and the
              owner session can read no receipt evidence. So the condition is
              stated, true whether or not reporting is switched on. */}
          Shows what the email and text providers report back. An email that bounces after sending
          appears here only once Hone is receiving the email provider&apos;s delivery reports, so no
          email problem listed does not prove every email arrived. Accepted or delivered means the
          client&apos;s mail server or carrier took it, not that it was read.
        </p>
      </header>

      {concernsTruncated && (
        <p className="text-xs text-amber-800 dark:text-amber-300">
          Showing the most recent {OWNER_CONCERN_CAP} reports. Older reports are not listed.
        </p>
      )}

      {openConcerns.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-neutral-800 dark:text-neutral-200">
            {/* NOT "Reported by you" (Codex P2 4307428933). `owner_delivery_concerns`
                returns every concern for the STUDIO with no reporter filter, so a
                co-owner's report was shown to every other owner as their own.
                Attributing it to the studio is true for one owner and for five.
                Per-reporter attribution needs the query to return the reporter
                and is a separate product question. */}
            Reported by your studio: client says they did not receive it ({openConcerns.length} open)
          </p>
          <ul className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-400">
            {openConcerns.map((c) => (
              <li key={c.concern_id}>
                {concernLabel(c.channel, c.purpose)} · reported {formatWhen(c.reported_at, timezone)} · when reported,{" "}
                {ledgerStatusWords(c.ledger_status_at_report)} ·{" "}
                <Link href={`/calendar/${c.appointment_id}`} className="underline">
                  appointment
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

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

/** Shown to the owner when the read failed: unknown, never "no problems". */
function DeliveryStatusUnavailable() {
  return (
    <section
      aria-labelledby="owner-delivery-heading"
      role="status"
      className="flex flex-col gap-1 rounded-lg border border-neutral-300 p-4 dark:border-neutral-700"
    >
      <h3 id="owner-delivery-heading" className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
        Message delivery
      </h3>
      <p className="text-xs text-neutral-700 dark:text-neutral-300">
        Delivery status is unavailable right now, so it is unknown whether any messages failed. Reload the page to
        try again.
      </p>
    </section>
  );
}
