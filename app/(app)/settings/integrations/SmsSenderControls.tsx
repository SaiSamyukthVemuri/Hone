"use client";

import { useActionState } from "react";
import {
  adoptSenderNumberAction,
  provisionSenderNumberAction,
  searchSenderNumbersAction,
  type SenderControlResult,
} from "./sender-control-actions";
import { DEMO_ADOPTION_INVENTORY } from "@/lib/sms/sender-controls-demo";
import type { SearchResult } from "@/lib/sms/sender-controls";

// SMS-SENDER-CONTROL-01 (#824): rendered only when the page's gate is open,
// which is never in production and never with live provisioning armed. Every
// action re-checks the same gate on the server. FAKE PROVIDER: nothing here
// buys a number, registers anything or sends a real text.

const field = "rounded border px-2 py-1";

export function SmsSenderControls() {
  const [search, searchAction, searching] = useActionState<SearchResult | null, FormData>(searchSenderNumbersAction, null);
  const [provision, provisionAction, provisioning] = useActionState<SenderControlResult | null, FormData>(provisionSenderNumberAction, null);
  const [adopt, adoptAction, adopting] = useActionState<SenderControlResult | null, FormData>(adoptSenderNumberAction, null);

  return (
    <div data-testid="sms-sender-controls" className="rounded-lg border border-dashed border-amber-400 p-5">
      <h3 className="text-sm font-semibold">Set up a studio number</h3>
      <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
        Fake provider: this is a demonstration of the setup flow. No number is bought and no text is sent.
      </p>

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
                <button type="submit" disabled={provisioning} className="rounded-md border px-2 py-0.5 text-xs">Use this number</button>
              </form>
            </li>
          ))}
        </ul>
      )}
      {provision && <p role="status" className={`mt-2 text-sm ${provision.ok ? "text-emerald-800" : "text-red-700"}`}>{provision.message}</p>}

      <details className="mt-4 text-sm">
        <summary>Use a number the studio already has (support-assisted)</summary>
        <p className="mt-2 text-xs text-amber-800 dark:text-amber-300" data-testid="sms-sender-demo-inventory">
          Fake provider: the demo account owns {DEMO_ADOPTION_INVENTORY.numbers.CA.phoneNumber} (Canada) and{" "}
          {DEMO_ADOPTION_INVENTORY.numbers.US.phoneNumber} (United States), both in messaging service{" "}
          {DEMO_ADOPTION_INVENTORY.messagingServiceSid}. The number must match the country chosen.
        </p>
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
          <button type="submit" disabled={adopting} className="rounded-md border px-3 py-1">Adopt</button>
        </form>
        {adopt && <p role="status" className={`mt-2 ${adopt.ok ? "text-emerald-800" : "text-red-700"}`}>{adopt.message}</p>}
      </details>
    </div>
  );
}
