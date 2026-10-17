"use client";

import { useActionState } from "react";
import {
  adoptSenderNumberAction,
  provisionSenderNumberAction,
  releaseSenderClaimAction,
  searchSenderNumbersAction,
  type SenderControlResult,
} from "./sender-control-actions";
import type { DemoAdoptionInventory } from "@/lib/sms/sender-controls-demo";
import type { SearchResult, SenderRecovery } from "@/lib/sms/sender-controls";

// SMS-SENDER-CONTROL-01 (#824): rendered only when the page's gate is open.
// FAKE mode (never in production, never with live provisioning armed): nothing
// here buys a number, registers anything or sends a real text. LIVE mode
// (HON-50; production only, operator-allowlisted studio, ships closed): the
// owner confirms each purchase and names the phone for the one test text.
// Every action re-checks the gate and the confirmation on the server; these
// fields are the owner's words, not the authority.

const field = "rounded border px-2 py-1";

export function SmsSenderControls({
  mode,
  inventory,
  recovery,
}: {
  mode: "fake" | "live";
  /** Fake mode only: this studio's own fake account inventory (lib/sms/sender-controls-demo.ts). */
  inventory: DemoAdoptionInventory | null;
  /**
   * What an errored setup offers (senderRecoveryFor): release ("choose a
   * different number"), support (no self-service action can be honest without
   * the setup's origin), or none (not in error). The release action re-checks
   * everything on the server.
   */
  recovery: SenderRecovery;
}) {
  const [search, searchAction, searching] = useActionState<SearchResult | null, FormData>(searchSenderNumbersAction, null);
  const [provision, provisionAction, provisioning] = useActionState<SenderControlResult | null, FormData>(provisionSenderNumberAction, null);
  const [adopt, adoptAction, adopting] = useActionState<SenderControlResult | null, FormData>(adoptSenderNumberAction, null);
  const [release, releaseAction, releasing] = useActionState<SenderControlResult | null, FormData>(releaseSenderClaimAction, null);

  return (
    <div data-testid="sms-sender-controls" className="rounded-lg border border-dashed border-amber-400 p-5">
      <h3 className="text-sm font-semibold">Set up a studio number</h3>
      {mode === "fake" ? (
        <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
          Fake provider: this is a demonstration of the setup flow. No number is bought and no text is sent.
        </p>
      ) : (
        <p className="mt-1 text-xs text-neutral-700 dark:text-neutral-300" data-testid="sms-sender-live-notice">
          Choosing a number buys it on the studio&apos;s Twilio account, which bills a monthly fee for each number. Setup ends with one test text to a phone you name.
        </p>
      )}

      <form action={searchAction} className="mt-3 flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col">
          Country
          <select name="country" className={field} defaultValue="CA">
            <option value="CA">Canada</option>
            <option value="US">United States</option>
          </select>
        </label>
        <label className="flex flex-col">
          Area code
          <input name="area_code" inputMode="numeric" maxLength={5} className={field} />
        </label>
        <button type="submit" disabled={searching} className="rounded-md border px-3 py-1">Find numbers</button>
      </form>

      {search && !search.ok && <p role="alert" className="mt-2 text-sm text-red-700">{search.reason}</p>}
      {search?.ok && (
        <ul className="mt-3 flex flex-col gap-2 text-sm" data-testid="sms-sender-candidates">
          {search.candidates.map((c) => (
            <li key={c.phoneNumber} className="flex flex-wrap items-center gap-2">
              <span className="font-medium tabular-nums">{c.formatted}</span>
              <span className="text-neutral-500">{[c.locality, c.region, c.country].filter(Boolean).join(", ")}</span>
              <form action={provisionAction}>
                <input type="hidden" name="country" value={c.country} />
                <input type="hidden" name="phone_number" value={c.phoneNumber} />
                {/* The searched area code travels with the choice (Codex P2 4253781002). */}
                {search.areaCode ? <input type="hidden" name="area_code" value={search.areaCode} /> : null}
                {/* G3: the confirmation names THIS number; the server refuses any other. */}
                <input type="hidden" name="confirm_number" value={c.phoneNumber} />
                <label className="inline-flex items-center gap-1 text-xs">
                  <input type="checkbox" name="confirm_cost" value="yes" required />
                  {mode === "live" ? "Buy this number (monthly fee on the studio's Twilio account)" : "Set up this number (fake provider: nothing is bought)"}
                </label>
                {mode === "live" ? <LiveTestTextFields /> : null}
                <button type="submit" disabled={provisioning} className="rounded-md border px-2 py-0.5 text-xs">Use this number</button>
              </form>
            </li>
          ))}
        </ul>
      )}
      {provision && <p role="status" className={`mt-2 text-sm ${provision.ok ? "text-emerald-800" : "text-red-700"}`}>{provision.message}</p>}

      {recovery === "support" && (
        <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-400" data-testid="sms-sender-support">
          The last setup attempt did not finish and cannot be continued from this screen. Contact Hone support to finish or undo it.
        </p>
      )}

      {recovery === "release" && (
        <form action={releaseAction} className="mt-4 text-sm" data-testid="sms-sender-release">
          <p className="text-neutral-600 dark:text-neutral-400">
            The last setup attempt did not finish. If it failed before a number was bought, you can release it and choose a different number.
          </p>
          <button type="submit" disabled={releasing} className="mt-2 rounded-md border px-3 py-1">
            Choose a different number
          </button>
          {release && <p role="status" className={`mt-2 ${release.ok ? "text-emerald-800" : "text-red-700"}`}>{release.message}</p>}
        </form>
      )}

      <details className="mt-4 text-sm">
        <summary>Use a number the studio already has (support-assisted)</summary>
        {inventory ? (
          <p className="mt-2 text-xs text-amber-800 dark:text-amber-300" data-testid="sms-sender-demo-inventory">
            Fake provider: the demo account owns {inventory.numbers.CA.phoneNumber} (Canada) and{" "}
            {inventory.numbers.US.phoneNumber} (United States), both in messaging service{" "}
            {inventory.messagingServiceSid}. The number must match the country chosen.
          </p>
        ) : null}
        <form action={adoptAction} className="mt-2 flex flex-wrap items-end gap-2">
          <label className="flex flex-col">
            Country
            <select name="country" className={field} defaultValue="CA">
              <option value="CA">Canada</option>
              <option value="US">United States</option>
            </select>
          </label>
          <label className="flex flex-col">
            Number (E.164)
            <input name="phone_number" placeholder="+14165550123" className={field} />
          </label>
          <label className="flex flex-col">
            Messaging service (from Hone support)
            <input name="messaging_service_sid" placeholder="MG…" className={field} />
          </label>
          {mode === "live" ? <LiveTestTextFields /> : null}
          <button type="submit" disabled={adopting} className="rounded-md border px-3 py-1">Adopt</button>
        </form>
        {adopt && <p role="status" className={`mt-2 ${adopt.ok ? "text-emerald-800" : "text-red-700"}`}>{adopt.message}</p>}
      </details>
    </div>
  );
}

/** Live mode: the owner's own phone for the one test text, and their agreement to it. */
function LiveTestTextFields() {
  return (
    <>
      <label className="flex flex-col text-xs">
        Your mobile, for one test text
        <input name="test_destination" inputMode="tel" placeholder="+1…" className={field} required />
      </label>
      <label className="inline-flex items-center gap-1 text-xs">
        <input type="checkbox" name="confirm_test_text" value="yes" required />
        Send one test text to this number
      </label>
    </>
  );
}
