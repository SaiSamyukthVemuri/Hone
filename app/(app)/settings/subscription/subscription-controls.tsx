"use client";

import { useId, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { PLANS, PLAN_KEYS, teamAllowance, type PlanKey } from "@/lib/subscriptions/plans";
import { changeSubscription } from "./actions";

function Confirm({ cancel, disabled, label }: { cancel: boolean; disabled: boolean; label: string }) {
  const { pending } = useFormStatus();
  return <Button variant={cancel ? "danger" : "primary"} type="submit" pending={pending} disabled={disabled}>{label}</Button>;
}

export function SubscriptionControls({ kind, studioId, studioName, current, version, soloFits }: {
  kind: "tier" | "cancel"; studioId: string; studioName: string; current: PlanKey; version: string | null; soloFits: boolean | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState(current);
  const title = useId();
  const cancel = kind === "cancel";
  return <div>
    <Button size="sm" onClick={() => { setSelected(current); dialog.current?.showModal(); }}>{cancel ? "Cancel subscription" : "Change tier"}</Button>
    <dialog ref={dialog} aria-labelledby={title}
      className="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-md overflow-auto rounded-xl border border-line bg-surface p-5 text-fg shadow-xl backdrop:bg-black/40 sm:p-6">
      <form onSubmit={() => dialog.current?.close()} action={changeSubscription.bind(null, studioId, version)} className="space-y-5">
        <div className="space-y-2"><h3 id={title} className="text-lg font-semibold">{cancel ? "Cancel your subscription now?" : "Change tier"}</h3>
          <p className="text-sm text-fg-muted">{cancel
            ? "Studio access for " + studioName + " will pause immediately for your whole team. Your records are kept and you can still open Billing and download invoices."
            : "Choose a monthly tier for " + studioName + ". Your owner account uses one practitioner seat."}</p></div>
        {cancel ? <><input type="hidden" name="target" value="cancel"/><input type="hidden" name="confirm" value="cancel-now"/></> :
          <fieldset className="space-y-2"><legend className="sr-only">Monthly tiers</legend>
            {PLAN_KEYS.map(key => {
              const blocked = key === "solo" && current !== key && soloFits === false;
              return <label key={key} className={'flex items-start gap-3 rounded-lg border p-3 ' + (selected === key ? 'border-fg bg-surface-sunken' : 'border-line')}>
                <input className="mt-1" name="target" value={key} type="radio" checked={selected === key} disabled={blocked} onChange={() => setSelected(key)}/>
                <span className="min-w-0 flex-1 text-sm"><span className="flex flex-wrap items-baseline justify-between gap-x-3"><strong>{PLANS[key].label}{key === current && " · Current"}</strong><span>US${PLANS[key].unitAmount / 100}/month</span></span>
                <span className="mt-1 block text-fg-muted">{teamAllowance(key)}</span>
                {blocked && <span className="mt-2 block">Remove extra team members or revoke pending invitations in Settings → Team to use Solo.</span>}</span>
              </label>;
            })}
          </fieldset>}
        <p className="text-sm text-fg-muted">{cancel ? "Future monthly renewals stop." : "Seat limits change when you confirm. The new monthly price starts at your next renewal. There is no charge or credit today."}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={() => dialog.current?.close()}>{cancel ? "Keep subscription" : "Back"}</Button>
          <Confirm cancel={cancel} disabled={!cancel && selected === current} label={cancel ? "Cancel subscription now" : "Switch to " + PLANS[selected].label}/>
        </div>
      </form>
    </dialog>
  </div>;
}
