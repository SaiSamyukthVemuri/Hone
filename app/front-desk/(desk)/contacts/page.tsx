import { requireReceptionistWithStudio } from "@/lib/receptionist/identity";
import { searchFrontDeskContacts } from "@/lib/receptionist/projections";

// STUDIO-READY-02d (#824): client CONTACT search, from receptionist_client_contacts
// only. It returns name, phone and email, and intake/consent COMPLETION only:
// never health answers, signed content, notes or any other clinical column.
export const dynamic = "force-dynamic";

/** A completion date, in the STUDIO's timezone, never the server's. */
function date(iso: string | null, timeZone: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(
    new Date(iso),
  );
}

export default async function FrontDeskContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const { studio } = await requireReceptionistWithStudio();
  const raw = (await searchParams).q;
  const q = (Array.isArray(raw) ? raw[0] : raw)?.trim().slice(0, 80) ?? "";
  const tooShort = q.length > 0 && q.length < 2;
  const contacts = tooShort ? [] : await searchFrontDeskContacts(studio.id, q || null);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-medium">Contacts</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Contact details and whether intake and consent are complete. Clinical information is not available at the
          front desk.
        </p>
      </div>
      <form method="get" className="flex gap-2" role="search">
        <label htmlFor="q" className="sr-only">
          Search by name, email or phone
        </label>
        <input
          id="q"
          name="q"
          defaultValue={q}
          placeholder="Name, email or phone"
          className="w-full max-w-sm rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button type="submit" className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700">
          Search
        </button>
      </form>
      {tooShort && <p className="text-sm text-neutral-500">Type at least two characters.</p>}
      {!tooShort && contacts.length === 0 && <p className="text-sm text-neutral-500">No matching clients.</p>}
      {contacts.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-neutral-500">
              <tr>
                <th className="px-4 py-2 font-normal">Name</th>
                <th className="px-4 py-2 font-normal">Phone</th>
                <th className="px-4 py-2 font-normal">Email</th>
                <th className="px-4 py-2 font-normal">Intake</th>
                <th className="px-4 py-2 font-normal">Consent</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {contacts.map((c) => (
                <tr key={c.client_id}>
                  <td className="px-4 py-2">{c.name}</td>
                  <td className="px-4 py-2 tabular-nums">{c.phone ?? "—"}</td>
                  <td className="px-4 py-2">{c.email ?? "—"}</td>
                  <td className="px-4 py-2">
                    {c.intake_status === "none" ? "Not started" : c.intake_status.replace(/_/g, " ")}
                    {c.intake_submitted_at ? ` · ${date(c.intake_submitted_at, studio.timezone)}` : ""}
                  </td>
                  <td className="px-4 py-2">{c.consent_accepted_at ? `Signed ${date(c.consent_accepted_at, studio.timezone)}` : "Not signed"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
