import type { LiveRegistrationState, RegistrationKind } from "@/lib/sms/sender-registration";
import { recordSmsRegistrationAction } from "./actions";

// SMS-SENDER-REG-01 (#824): the operator's record of a studio's US SMS
// registration evidence. Recording here is a statement that support has
// checked the provider account; it calls no provider and activates nothing.
//
// BOUND TO ONE SENDER. The section renders from one snapshot of the studio's
// live sender and that sender's records. The form carries that sender's id,
// and the 0217 command writes only if it is STILL the live sender
// (`sender_changed` otherwise). With no readable state, or no single live
// sender, there is no form at all; the action refuses the same cases.

const KIND_LABEL: Record<RegistrationKind, string> = {
  us_10dlc: "A2P 10DLC (brand, campaign, number)",
  toll_free_verification: "Toll-free verification",
};

export function SmsRegistrationSection({
  studioId,
  state,
}: {
  studioId: string;
  state: LiveRegistrationState;
}) {
  const record = async (formData: FormData) => {
    "use server";
    const out = await recordSmsRegistrationAction(studioId, formData);
    // Say a refusal out loud rather than re-render as if it were recorded.
    if (!out.ok) throw new Error(out.error ?? "The registration could not be recorded.");
  };

  const heading = <h2 className="mb-3 text-xl font-medium">US SMS registration</h2>;

  if (!state.ok) {
    return (
      <section data-testid="admin-sms-registration" data-state="unreadable">
        {heading}
        <p className="text-sm text-red-700">
          The studio&apos;s sender and registration records could not be loaded.
          Recording is unavailable until they can be read.
        </p>
      </section>
    );
  }
  if (state.senders.length === 0) {
    return (
      <section data-testid="admin-sms-registration" data-state="no-live-sender">
        {heading}
        <p className="text-sm text-neutral-500">
          This studio has no live SMS sender, so there is nothing to record registration against.
        </p>
      </section>
    );
  }
  if (state.senders.length > 1) {
    return (
      <section data-testid="admin-sms-registration" data-state="ambiguous">
        {heading}
        <p className="text-sm text-red-700">
          This studio has more than one live sender. Recording is unavailable until that is resolved.
        </p>
      </section>
    );
  }

  const sender = state.senders[0];
  return (
    <section data-testid="admin-sms-registration" data-state="ready">
      {heading}
      <p className="mb-2 text-sm">
        Current number:{" "}
        <strong data-testid="admin-sms-registration-number">{sender.phone_number ?? "not assigned yet"}</strong>{" "}
        <span className="text-neutral-500">({sender.status})</span>
      </p>
      {state.registrations.length === 0 ? (
        <p className="text-sm text-neutral-500">Nothing recorded for this number. US readiness shows Requires information.</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {state.registrations.map((r) => (
            <li key={`${r.sender_id}:${r.kind}`}>
              {KIND_LABEL[r.kind]}: <strong>{r.status}</strong>
              {r.missing_information ? ` (missing: ${r.missing_information})` : ""}
              {r.provider_reference ? ` · ref ${r.provider_reference}` : ""}
            </li>
          ))}
        </ul>
      )}
      <form action={record} className="mt-3 flex flex-wrap items-end gap-2 text-sm">
        <input type="hidden" name="expected_sender_id" value={sender.id} />
        <label className="flex flex-col">
          Kind
          <select name="kind" className="rounded border px-2 py-1" defaultValue="us_10dlc">
            <option value="us_10dlc">A2P 10DLC</option>
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
        <button type="submit" className="rounded-md border px-3 py-1">
          Record for {sender.phone_number ?? "this sender"}
        </button>
      </form>
      <p className="mt-2 text-xs text-neutral-500">
        Record only what you verified in the provider account for the number shown. If the
        studio&apos;s number has changed since this page loaded, the record is refused. This changes
        the readiness shown to the studio; it does not register or activate anything, and it is
        not HIPAA coverage.
      </p>
    </section>
  );
}
