"use client";

import { useId, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { PLANS, PLAN_KEYS, teamAllowance, type PlanKey } from "@/lib/subscriptions/plans";
import type { SoloImpact } from "@/lib/subscriptions/owner-billing";
import { changeSubscription } from "./actions";

function Confirm({ cancel, disabled, label }: { cancel: boolean; disabled: boolean; label: string }) {
  const { pending } = useFormStatus();
  return <Button variant={cancel ? "danger" : "primary"} type="submit" pending={pending} disabled={disabled}>{label}</Button>;
}

export function SubscriptionControls({ kind, studioId, studioName, current, version, soloImpact }: {
  kind: "tier" | "cancel"; studioId: string; studioName: string; current: PlanKey; version: string | null; soloImpact: SoloImpact | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState(current);
  const title = useId();
  const cancel = kind === "cancel";
  const downgrading = !cancel && current === "studio" && selected === "solo";
  const affectsTeam = downgrading && soloImpact && (soloImpact.members.length > 0 || soloImpact.invitations.length > 0);
  const confirmLabel = cancel ? "Cancel subscription now" : affectsTeam ? "Remove team access and switch to Solo" : "Switch to " + PLANS[selected].label;
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
              return <label key={key} className={'flex items-start gap-3 rounded-lg border p-3 ' + (selected === key ? 'border-fg bg-surface-sunken' : 'border-line')}>
                <input className="mt-1" name="target" value={key} type="radio" checked={selected === key} onChange={() => setSelected(key)}/>
                <span className="min-w-0 flex-1 text-sm"><span className="flex flex-wrap items-baseline justify-between gap-x-3"><strong>{PLANS[key].label}{key === current && " · Current"}</strong><span>US${PLANS[key].unitAmount / 100}/month</span></span>
                <span className="mt-1 block text-fg-muted">{teamAllowance(key)}</span>
                </span>
              </label>;
            })}
          </fieldset>}
        {!cancel && current === "studio" && <div data-solo-impact="" hidden={!downgrading} aria-live="polite" className="space-y-2 rounded-lg border border-line p-3 text-sm">
          {soloImpact ? <>
            <input type="hidden" name="teamVersion" value={soloImpact.version}/>
            <p><strong>{soloImpact.owner}</strong> keeps the owner seat and full studio access.</p>
            {soloImpact.members.length > 0 && <div><p className="font-medium">Will lose access to this studio</p>
              <ul className="list-disc pl-5">{soloImpact.members.map((member, i) => <li key={i}>{member.name} · {member.role}</li>)}</ul></div>}
            {soloImpact.invitations.length > 0 && <div><p className="font-medium">Invitations Hone will revoke</p>
              <ul className="list-disc break-all pl-5">{soloImpact.invitations.map(email => <li key={email}>{email}</li>)}</ul></div>}
            {soloImpact.members.length + soloImpact.invitations.length === 0 ? <p>There are no other active members or pending invitations.</p> :
              <p>Hone makes these changes automatically when the switch succeeds. Existing appointments and charts stay in the studio.</p>}
            {!soloImpact.can_confirm && <p>Only the subscription owner can confirm this change.</p>}
          </> : <p>Refresh Billing to load the team affected by this change.</p>}
        </div>}
        <p className="text-sm text-fg-muted">{cancel ? "Future monthly renewals stop." : "Seat limits change when the tier switch succeeds. The new monthly price starts at your next renewal. There is no charge or credit today."}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={() => dialog.current?.close()}>{cancel ? "Keep subscription" : "Back"}</Button>
          <Confirm cancel={cancel} disabled={(!cancel && selected === current) || (downgrading && !soloImpact?.can_confirm)} label={confirmLabel}/>
        </div>
      </form>
    </dialog>
  </div>;
}
