"use client";

import { useActionState } from "react";
import type { CheckSmsCampaignResult } from "./actions";

// SMS-CAMPAIGN-CHECK-01 (HON-50 G4b): support's "Check US campaign" button.
// Bound to the sender and number shown; the server reads the Messaging
// Service from the snapshot, checks the provider (GET only) and records the
// observation through 0229. The verdict line is computed on the server from
// the recorded binding, the same way the send path decides.

const VERDICT_WORDS: Record<string, string> = {
  ok: "Verified campaign, recorded after this sender was set up.",
  missing: "No campaign check recorded for this sender.",
  mismatch: "The recorded check was for another number or Messaging Service. Check again.",
  unverified: "The campaign was not verified when last checked.",
  stale: "Checked before this sender was set up. Check again.",
};

export function SmsCampaignCheckForm({
  action,
  senderId,
  phoneNumber,
  verdict,
}: {
  action: (previous: CheckSmsCampaignResult | null, formData: FormData) => Promise<CheckSmsCampaignResult>;
  senderId: string;
  phoneNumber: string;
  /** "ok", or the verdict's reason. */
  verdict: string;
}) {
  const [state, formAction, pending] = useActionState<CheckSmsCampaignResult | null, FormData>(action, null);
  return (
    <div className="mt-4 border-t pt-3 text-sm" data-testid="admin-sms-campaign">
      <h3 className="font-medium">US campaign</h3>
      <p className="mt-1" data-testid="admin-sms-campaign-verdict" data-verdict={verdict}>
        {VERDICT_WORDS[verdict] ?? verdict}
      </p>
      <form action={formAction} className="mt-2 flex flex-wrap items-end gap-2">
        <input type="hidden" name="expected_sender_id" value={senderId} />
        <input type="hidden" name="expected_phone_number" value={phoneNumber} />
        <label className="flex flex-col">
          When
          <select name="context" defaultValue="evidence" className="rounded border px-2 py-1">
            <option value="evidence">Recording evidence</option>
            <option value="cutover">Before cutover</option>
          </select>
        </label>
        <button type="submit" disabled={pending} className="rounded-md border px-3 py-1">
          {pending ? "Checking…" : "Check US campaign"}
        </button>
      </form>
      {state ? (
        <p role={state.ok ? "status" : "alert"} data-result={state.result} className={state.ok ? "mt-2 text-green-700" : "mt-2 text-red-700"}>
          {state.message}
        </p>
      ) : null}
      <p className="mt-2 text-xs text-neutral-500">
        Reads the provider only; it changes nothing there. The send path uses the recorded result.
      </p>
    </div>
  );
}
