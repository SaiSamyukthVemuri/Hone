import { recordSmsRegistrationAction } from "./actions";

// SMS-SENDER-REG-01 (#824): the operator's record of a studio's US SMS
// registration evidence. Recording here is a statement that support has
// checked the provider account; it calls no provider and activates nothing.

export type AdminRegistrationRow = {
  kind: "us_10dlc" | "toll_free_verification";
  status: string;
  missing_information: string | null;
  provider_reference: string | null;
  updated_at: string;
  /** The live sender's number: the evidence below is about THIS number. */
  phone_number: string | null;
};

const KIND_LABEL: Record<AdminRegistrationRow["kind"], string> = {
  us_10dlc: "US 10DLC (brand, campaign, number)",
  toll_free_verification: "Toll-free verification",
};

export function SmsRegistrationSection({
  studioId,
  rows,
  loadError,
}: {
  studioId: string;
  rows: AdminRegistrationRow[];
  loadError: boolean;
}) {
  const record = async (formData: FormData) => {
    "use server";
    const out = await recordSmsRegistrationAction(studioId, formData);
    // Say a refusal out loud (like the console's other actions) rather than
    // re-render as if the record had been made.
    if (!out.ok) throw new Error(out.error ?? "The registration could not be recorded.");
  };
  return (
    <section data-testid="admin-sms-registration">
      <h2 className="mb-3 text-xl font-medium">US SMS registration</h2>
      {loadError ? (
        <p className="text-sm text-red-700">Registration records could not be loaded.</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-neutral-500">Nothing recorded. US readiness shows Requires information.</p>
      ) : (
        <>
        <p className="mb-1 text-sm text-neutral-500">
          For the studio&apos;s current number{rows[0].phone_number ? ` ${rows[0].phone_number}` : ""}. Records for released numbers are not shown.
        </p>
        <ul className="flex flex-col gap-1 text-sm">
          {rows.map((r) => (
            <li key={r.kind}>
              {KIND_LABEL[r.kind]}: <strong>{r.status}</strong>
              {r.missing_information ? ` (missing: ${r.missing_information})` : ""}
              {r.provider_reference ? ` · ref ${r.provider_reference}` : ""}
            </li>
          ))}
        </ul>
        </>
      )}
      <form action={record} className="mt-3 flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col">
          Kind
          <select name="kind" className="rounded border px-2 py-1" defaultValue="us_10dlc">
            <option value="us_10dlc">US 10DLC</option>
            <option value="toll_free_verification">Toll-free verification</option>
          </select>
        </label>
        <label className="flex flex-col">
          Status
          <select name="status" className="rounded border px-2 py-1" defaultValue="pending">
            <option value="pending">pending</option>
            <option value="requires_information">requires_information</option>
            <option value="approved">approved</option>
            <option value="rejected">rejected</option>
            <option value="suspended">suspended</option>
          </select>
        </label>
        <label className="flex flex-col">
          Missing information
          <input name="missing_information" maxLength={300} className="rounded border px-2 py-1" />
        </label>
        <label className="flex flex-col">
          Provider reference
          <input name="provider_reference" maxLength={64} className="rounded border px-2 py-1" />
        </label>
        <button type="submit" className="rounded-md border px-3 py-1">Record</button>
      </form>
      <p className="mt-2 text-xs text-neutral-500">
        Record only what you verified in the provider account. This changes the
        readiness shown to the studio; it does not register or activate anything.
      </p>
    </section>
  );
}
