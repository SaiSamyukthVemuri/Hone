import { registrationKindFor, type LiveRegistrationState, type RegistrationKind } from "@/lib/sms/sender-registration";
import { recordSmsRegistrationFormAction } from "./actions";
import { SmsRegistrationForm } from "./SmsRegistrationForm";

// SMS-SENDER-REG-01 (#824): the operator's record of a studio's US SMS
// registration evidence. Recording here is a statement that support has
// checked the provider account; it calls no provider and activates nothing.
//
// BOUND TO ONE SENDER AND ONE NUMBER. The section renders from one snapshot
// of the studio's live sender and the evidence for the number it holds now.
// The form carries that sender's id and number, and the 0217 command writes
// only if both are STILL live (`sender_changed` otherwise). There is no form
// with no readable state, no single live sender, no number yet, or a number
// outside CA/US/toll-free; the action and the command refuse the same cases.
// The kind is the number's (toll-free verification or A2P 10DLC), shown and
// never chosen.

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
  const kind = registrationKindFor(sender.phone_number);
  // The record the form would replace: this sender, this number, this kind.
  const current =
    state.registrations.find(
      (r) => r.sender_id === sender.id && r.phone_number === sender.phone_number && r.kind === kind,
    ) ?? null;
  // No number yet, or one Hone does not serve: nothing support could verify.
  const form =
    sender.phone_number && kind ? (
      <SmsRegistrationForm
        action={recordSmsRegistrationFormAction.bind(null, studioId)}
        senderId={sender.id}
        phoneNumber={sender.phone_number}
        kindLabel={KIND_LABEL[kind]}
        current={current}
      />
    ) : (
      <p className="mt-3 text-sm text-neutral-500" data-testid="admin-sms-registration-unavailable">
        {sender.phone_number
          ? "This number is not a Canadian, US or toll-free number, so Hone records no registration for it."
          : "This sender has no number yet. Recording becomes available once a number is assigned."}
      </p>
    );
  const dataState = !sender.phone_number ? "no-number" : kind ? "ready" : "unsupported-number";
  return (
    <section data-testid="admin-sms-registration" data-state={dataState}>
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
            <li key={`${r.sender_id}:${r.phone_number}:${r.kind}`}>
              {KIND_LABEL[r.kind]} for {r.phone_number}: <strong>{r.status}</strong>
              {r.missing_information ? ` (missing: ${r.missing_information})` : ""}
              {r.provider_reference ? ` · ref ${r.provider_reference}` : ""}
            </li>
          ))}
        </ul>
      )}
      {form}
      <p className="mt-2 text-xs text-neutral-500">
        Record only what you verified in the provider account for the number shown. If the
        studio&apos;s number has changed since this page loaded, the record is refused. This changes
        the readiness shown to the studio; it does not register or activate anything, and it is
        not HIPAA coverage.
      </p>
    </section>
  );
}
