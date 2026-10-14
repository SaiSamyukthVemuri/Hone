"use client";

import { useActionState, type ReactNode } from "react";
import type { RecordSmsRegistrationResult } from "./actions";

export type CurrentRecord = {
  status: string;
  missing_information: string | null;
  provider_reference: string | null;
  /** The record's version, exactly as the database gave it. */
  updated_at: string;
};

// SMS-SENDER-REG-01 (#824): the operator's record form, bound to ONE sender
// and ONE number. The kind is that number's and is shown, never chosen
// (Codex P2 4244484022). Every outcome, a refusal included, comes back as
// state and is rendered here; nothing is thrown (Codex P2 4244484024).
//
// "approved" IS COMPLETE (Codex P2 4253281361, decision on #863): for A2P 10DLC
// the brand, the campaign AND this number's own registration, which Twilio
// completes separately after campaign approval; for toll-free, completed
// verification of this number. A number still UNREGISTERED or
// PENDING_REGISTRATION is recorded as pending, and a failed one as rejected.
//
// PREFILLED FROM THE CURRENT RECORD (Codex P2 4248698137). A submission
// replaces the record for this number, so an untouched form must say what is
// already recorded: re-submitting to add a reference can never quietly turn an
// approval into "pending" or drop what is missing. The defaults apply only
// when nothing is recorded yet.

/** The one sender and number a form records against, and the record it shows. */
export type RegistrationTarget = {
  senderId: string;
  phoneNumber: string;
  kindLabel: string;
  /** The record for this sender, number and kind, if there is one. */
  current: CurrentRecord | null;
};

/**
 * THE SECTION'S ONE STATEFUL ROOT (Codex P2 4270957975). The section renders
 * this component, unkeyed, at the same place in EVERY state it can be in --
 * unreadable, no live sender, several, no number, unsupported number, ready --
 * so the action's result survives whatever the refresh after a submit shows:
 * a newer record version (4266641804), a REPLACED sender or number, or a
 * RELEASED sender. Only the <form> element is keyed, by sender, number and
 * record version, so its uncontrolled fields always come from the record the
 * hidden fields name (4253596170, 4266543216) while "Recorded." or the
 * refusal stays on screen.
 */
export function SmsRegistrationPanel({
  action,
  dataState,
  intro,
  target,
  footer,
}: {
  action: (previous: RecordSmsRegistrationResult | null, formData: FormData) => Promise<RecordSmsRegistrationResult>;
  dataState: string;
  /** Server-rendered: the heading, the number and what is recorded. */
  intro: ReactNode;
  /** The sender and number to record against, or null when there is none. */
  target: RegistrationTarget | null;
  footer?: ReactNode;
}) {
  const [state, formAction, pending] = useActionState<RecordSmsRegistrationResult | null, FormData>(action, null);

  return (
    <section data-testid="admin-sms-registration" data-state={dataState}>
      {intro}
      {target ? <RegistrationForm key={formKey(target)} target={target} formAction={formAction} pending={pending} /> : null}
      {state ? (
        <p
          role={state.ok ? "status" : "alert"}
          data-testid="admin-sms-registration-result"
          data-result={state.result ?? (state.ok ? "recorded" : "error")}
          className={state.ok ? "mt-2 text-sm text-green-700" : "mt-2 text-sm text-red-700"}
        >
          {state.ok ? successText(state.phoneNumber, target?.phoneNumber ?? null) : (state.error ?? "The registration could not be recorded.")}
        </p>
      ) : null}
      {footer}
    </section>
  );
}

/**
 * SUCCESS NAMES ITS NUMBER (Codex P2 4274699533). The panel keeps its result
 * across a refresh (so a refusal stays visible), which means a success can
 * outlive the sender it was about: the sender may be replaced before the
 * refresh lands. "Recorded." beside a replacement number would read as that
 * number's approval. So the message names the number it recorded for, and
 * says plainly when that is no longer the studio's number.
 */
export function successText(recordedFor: string | undefined, shownNow: string | null): string {
  if (!recordedFor) return "Recorded.";
  if (shownNow !== recordedFor) {
    return `Recorded for ${recordedFor}. That is no longer this studio's number; nothing is recorded for the number shown now.`;
  }
  return `Recorded for ${recordedFor}.`;
}

/** A new form per sender, per number and per record version. */
export function formKey(t: RegistrationTarget): string {
  return `${t.senderId}:${t.phoneNumber}:${t.current?.updated_at ?? "none"}`;
}

/** The fields. Stateless: it remounts under a new key, the panel keeps the result. */
function RegistrationForm({
  target,
  formAction,
  pending,
}: {
  target: RegistrationTarget;
  formAction: (formData: FormData) => void;
  pending: boolean;
}) {
  const { senderId, phoneNumber, kindLabel, current } = target;
  return (
    <form action={formAction} className="mt-3 flex flex-wrap items-end gap-2 text-sm">
      <input type="hidden" name="expected_sender_id" value={senderId} />
      <input type="hidden" name="expected_phone_number" value={phoneNumber} />
      {/* NO LOST UPDATE (Codex P2 4266275222): the record this form shows, or
          none. A write against a record changed since is refused. */}
      <input type="hidden" name="expected_updated_at" value={current?.updated_at ?? ""} />
      <p className="flex flex-col">
        Kind
        <strong data-testid="admin-sms-registration-kind">{kindLabel}</strong>
      </p>
      <label className="flex flex-col">
        Status
        <select name="status" className="rounded border px-2 py-1" defaultValue={current?.status ?? "pending"}>
          <option value="pending">pending: anything not yet complete, including this number&apos;s own registration</option>
          <option value="requires_information">requires_information: something must be provided</option>
          <option value="approved">approved: COMPLETE for this number (brand, campaign and the number registered)</option>
          <option value="rejected">rejected: the registration or this number&apos;s registration failed</option>
          <option value="suspended">suspended</option>
        </select>
      </label>
      <label className="flex flex-col">
        Missing information
        <input
          name="missing_information"
          maxLength={300}
          defaultValue={current?.missing_information ?? ""}
          className="rounded border px-2 py-1"
        />
      </label>
      <label className="flex flex-col">
        Provider reference
        <input
          name="provider_reference"
          maxLength={64}
          defaultValue={current?.provider_reference ?? ""}
          className="rounded border px-2 py-1"
        />
      </label>
      <button type="submit" disabled={pending} className="rounded-md border px-3 py-1">
        {current ? `Update the record for ${phoneNumber}` : `Record for ${phoneNumber}`}
      </button>
      {current ? (
        <p className="w-full text-xs text-neutral-500" data-testid="admin-sms-registration-current">
          Currently recorded: <strong>{current.status}</strong>. Submitting replaces it.
        </p>
      ) : null}
    </form>
  );
}
