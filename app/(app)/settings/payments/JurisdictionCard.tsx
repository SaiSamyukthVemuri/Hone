"use client";

import { useState, useTransition } from "react";
import { confirmStudioJurisdictionAction } from "./jurisdiction-actions";

// Gate A. Shown only when the default-off switch is on and no country is
// stored yet. Nothing is preselected: Hone does not guess from location.
export function JurisdictionCard() {
  const [country, setCountry] = useState("");
  const [currency, setCurrency] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setMessage(null);
    const fd = new FormData();
    fd.set("country", country);
    fd.set("currency", currency);
    if (confirm) fd.set("confirm", "yes");
    startTransition(async () => {
      const r = await confirmStudioJurisdictionAction(fd);
      setMessage(r.ok ? "Saved. You can now connect Stripe." : r.error);
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded border border-neutral-200 p-4">
      <h3 className="text-base font-medium">Confirm your business country</h3>
      <p className="text-sm text-neutral-500">
        Your Stripe account is created in this country and it cannot be changed afterwards.
      </p>
      <label className="text-sm">
        Country
        <select className="mt-1 block w-full rounded border px-2 py-1" value={country} onChange={(e) => setCountry(e.target.value)}>
          <option value="">Choose…</option>
          <option value="CA">Canada</option>
          <option value="US">United States</option>
        </select>
      </label>
      <label className="text-sm">
        Currency you charge in
        <select className="mt-1 block w-full rounded border px-2 py-1" value={currency} onChange={(e) => setCurrency(e.target.value)}>
          <option value="">Choose…</option>
          <option value="cad">CAD</option>
          <option value="usd">USD</option>
        </select>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
        <span>I confirm these are my business details.</span>
      </label>
      <button type="submit" disabled={pending} className="self-start rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50">
        {pending ? "Saving…" : "Confirm"}
      </button>
      {message ? <p role="status" className="text-sm">{message}</p> : null}
    </form>
  );
}
