"use client";

import { useState, useTransition } from "react";

type Props = {
  clientId: string;
  action: (formData: FormData) => Promise<void>;
};

export function AddPricingForm({ clientId, action }: Props) {
  const [service, setService] = useState("");
  const [price, setPrice] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!service.trim()) {
      setError("Service is required.");
      return;
    }
    if (!price.trim() || !Number.isFinite(Number(price)) || Number(price) < 0) {
      setError("Price must be a non-negative number.");
      return;
    }

    const fd = new FormData();
    fd.set("client_id", clientId);
    fd.set("service_name", service);
    fd.set("price", price);
    fd.set("notes", notes);

    startTransition(async () => {
      try {
        await action(fd);
        setService("");
        setPrice("");
        setNotes("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to add pricing.");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_7rem_minmax(0,1fr)_auto]">
        <input
          value={service}
          onChange={(e) => setService(e.target.value)}
          placeholder="Service"
          aria-label="Service"
          className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-neutral-500">
            $
          </span>
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="0.00"
            aria-label="Price in dollars"
            type="number"
            step="0.01"
            min="0"
            inputMode="decimal"
            className="w-full rounded-md border border-neutral-300 bg-white py-2 pl-7 pr-3 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
        </div>
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes (optional)"
          aria-label="Notes"
          className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {pending ? "Adding…" : "+ Add"}
        </button>
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </form>
  );
}
