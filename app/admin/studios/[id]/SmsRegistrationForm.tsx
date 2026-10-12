"use client";

import { useActionState } from "react";
import type { RecordSmsRegistrationResult } from "./actions";

// SMS-SENDER-REG-01 (#824): the operator's record form, bound to ONE sender
// and ONE number. The kind is that number's and is shown, never chosen
// (Codex P2 4244484022). Every outcome, a refusal included, comes back as
// state and is rendered here; nothing is thrown (Codex P2 4244484024).

export function SmsRegistrationForm({
  action,
  senderId,
  phoneNumber,
  kindLabel,
}: {
  action: (previous: RecordSmsRegistrationResult | null, formData: FormData) => Promise<RecordSmsRegistrationResult>;
  senderId: string;
  phoneNumber: string;
  kindLabel: string;
}) {
  const [state, formAction, pending] = useActionState<RecordSmsRegistrationResult | null, FormData>(action, null);

  return (
    <>
      <form action={formAction} className="mt-3 flex flex-wrap items-end gap-2 text-sm">
        <input type="hidden" name="expected_sender_id" value={senderId} />
        <input type="hidden" name="expected_phone_number" value={phoneNumber} />
        <p className="flex flex-col">
          Kind
          <strong data-testid="admin-sms-registration-kind">{kindLabel}</strong>
        </p>
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
        <button type="submit" disabled={pending} className="rounded-md border px-3 py-1">
          Record for {phoneNumber}
        </button>
      </form>
      {state ? (
        <p
          role={state.ok ? "status" : "alert"}
          data-testid="admin-sms-registration-result"
          data-result={state.result ?? (state.ok ? "recorded" : "error")}
          className={state.ok ? "mt-2 text-sm text-green-700" : "mt-2 text-sm text-red-700"}
        >
          {state.ok ? "Recorded." : (state.error ?? "The registration could not be recorded.")}
        </p>
      ) : null}
    </>
  );
}
