import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { ExportButton } from "./ExportButton";

async function loadCounts(studioId: string): Promise<{
  clientCount: number;
  sessionCount: number;
  entryCount: number;
}> {
  const supabase = await createClient();
  const [clientsRes, sessionsRes, electRes, laserRes] = await Promise.all([
    supabase
      .from("clients")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", studioId),
    supabase
      .from("sessions")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", studioId),
    supabase
      .from("electrolysis_entries")
      .select("id", { count: "exact", head: true }),
    supabase
      .from("laser_entries")
      .select("id", { count: "exact", head: true }),
  ]);

  return {
    clientCount: clientsRes.count ?? 0,
    sessionCount: sessionsRes.count ?? 0,
    entryCount: (electRes.count ?? 0) + (laserRes.count ?? 0),
  };
}

function fmt(n: number): string {
  return n.toLocaleString();
}

export default async function DataSettingsPage() {
  const { studio } = await getCurrentPractitionerWithStudio();
  const { clientCount, sessionCount, entryCount } = await loadCounts(studio.id);

  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-5">
        <h2
          className="font-[var(--font-fraunces)] text-3xl font-bold tracking-tight"
          style={{ letterSpacing: "-0.025em" }}
        >
          Your data
        </h2>
        <p className="max-w-[640px] text-base leading-relaxed text-neutral-700 dark:text-neutral-300 md:text-lg">
          {studio.name} has {fmt(clientCount)}{" "}
          {clientCount === 1 ? "client" : "clients"}, {fmt(sessionCount)}{" "}
          {sessionCount === 1 ? "session" : "sessions"}, and {fmt(entryCount)}{" "}
          {entryCount === 1 ? "entry" : "entries"} in Hone.
        </p>
        <p className="max-w-[680px] text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
          All client records, session notes, and pricing belong to you. Hone
          uses third-party infrastructure that may process this data outside
          Canada — see the{" "}
          <a href="/privacy" className="underline">
            Privacy Policy
          </a>{" "}
          for current hosting and subprocessors. You can download a portable
          copy of your supported studio records at any time, import existing
          records from CSV (coming soon), or delete everything permanently
          (coming soon).
        </p>
      </section>

      <DataCard
        anchorId="export-data"
        title="Export your data"
        body="Download a portable copy of your supported studio records as a ZIP. Reads are paginated to exhaustion, so no file is silently truncated, and manifest.json records how many rows each file received. It is not point-in-time consistent and is not a transactional database backup — it does not replace Hone's disaster-recovery backups."
      >
        <div className="flex flex-col gap-5">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-neutral-500">
              Included
            </p>
            <ul className="mt-1.5 flex max-w-[600px] list-disc flex-col gap-1 pl-5 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
              <li>
                Clients: contact info, allergies, skin notes, Fitzpatrick
                type, emergency contacts
              </li>
              <li>
                Electrolysis &amp; laser sessions: notes, times, price, who
                performed them
              </li>
              <li>
                Electrolysis charting: treatment area, machine settings,
                blend/galvanic &amp; thermolysis readings, probe details, pulse
                count, hairs treated, observation chips, comments
              </li>
              <li>Laser entries</li>
              <li>Practitioners</li>
              <li>Per-client custom pricing</li>
              <li>
                Appointments: client, practitioner, service, start/end
                times, status, and appointment notes
              </li>
              <li>
                Treatment plans: primary area, status, estimated visits,
                and plan notes
              </li>
              <li>Treatment plan schedule stages</li>
              <li>
                Consultation notes &amp; skin/hair analyses: the full
                append-only clinical narrative, including superseded revisions
              </li>
              <li>
                Record-keeping logs: sterile supplies, disinfectants, and the
                record-keeping change history
              </li>
              <li>
                Exposure-incident log (owner-only): contains personal
                information about the exposed person — handle securely
              </li>
              <li>
                manifest.json: how many rows were exported to each file, plus
                whichever source-side count checks were available
              </li>
            </ul>
          </div>

          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-neutral-500">
              Not included
            </p>
            <p className="mt-1.5 max-w-[600px] text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
              Private warnings and personal notes are intentionally excluded
              from this general export.
            </p>
          </div>

          <p className="max-w-[600px] text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
            <span className="font-medium text-neutral-800 dark:text-neutral-200">
              Pilot tip:
            </span>{" "}
            after your first real charting day, download an export and keep
            your own copy of it somewhere safe. It is a portable record of your
            studio data, not a substitute for Hone&rsquo;s own backups.
          </p>

          <ExportButton />
        </div>
      </DataCard>

      <DataCard
        anchorId="import-csv"
        title="Import clients from CSV"
        body="Bring existing client records in from a spreadsheet."
      >
        <DisabledButton label="Coming this week" />
      </DataCard>

      <DataCard
        anchorId="delete-data"
        title="Delete all studio data"
        body="Permanently remove every client, session, and entry. This cannot be undone."
      >
        <DisabledButton label="Coming this week" />
      </DataCard>

      <p className="text-xs text-neutral-500">
        Encrypted at rest. Exportable at any time. Hosting and subprocessors,
        including where data is processed, are listed in the{" "}
        <a href="/privacy" className="underline">
          Privacy Policy
        </a>
        .
      </p>
    </div>
  );
}

function DataCard({
  anchorId,
  title,
  body,
  children,
}: {
  // Stable anchor so Global Search can resolve an individual data control
  // ("export", "delete all studio data") to its exact card, not the page top.
  anchorId: string;
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={anchorId}
      className="flex scroll-mt-24 flex-col gap-4 p-8"
      style={{ border: "1px solid #E5E2DA" }}
    >
      <h3 className="text-lg font-medium">{title}</h3>
      <p className="max-w-[600px] text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
        {body}
      </p>
      {children}
    </section>
  );
}

function DisabledButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      disabled
      className="cursor-not-allowed px-6 py-3 text-[13px] font-medium uppercase tracking-[0.15em] text-neutral-500"
      style={{ border: "1px solid #E5E2DA", backgroundColor: "transparent" }}
    >
      {label}
    </button>
  );
}
