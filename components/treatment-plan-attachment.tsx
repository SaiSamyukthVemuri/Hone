"use client";

import { useState, useTransition } from "react";
import type { TreatmentPlan } from "@/lib/types/database";

type Props = {
  sessionId: string;
  clientId: string;
  attachedPlan: { id: string; name: string; status: TreatmentPlan["status"] } | null;
  activePlans: ReadonlyArray<Pick<TreatmentPlan, "id" | "name">>;
  attachAction: (formData: FormData) => Promise<
    { ok: true } | { ok: false; error: string }
  >;
  detachAction: (formData: FormData) => Promise<
    { ok: true } | { ok: false; error: string }
  >;
};

// Renders the attach/detach widget on the session detail page. Four states:
//   1) Not attached + no active plans for client: render nothing
//   2) Not attached + one active plan: single "+ Attach to <name>" button
//   3) Not attached + multiple active plans: dropdown + Attach button
//   4) Attached (any plan status): "Treatment plan: <name>" + Detach link
export function TreatmentPlanAttachment({
  sessionId,
  clientId,
  attachedPlan,
  activePlans,
  attachAction,
  detachAction,
}: Props) {
  const [picked, setPicked] = useState(activePlans[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submitAttach(planId: string) {
    if (!planId) return;
    const fd = new FormData();
    fd.set("session_id", sessionId);
    fd.set("client_id", clientId);
    fd.set("plan_id", planId);
    setError(null);
    startTransition(async () => {
      const res = await attachAction(fd);
      if (!res.ok) setError(res.error);
    });
  }

  function submitDetach() {
    const fd = new FormData();
    fd.set("session_id", sessionId);
    fd.set("client_id", clientId);
    setError(null);
    startTransition(async () => {
      const res = await detachAction(fd);
      if (!res.ok) setError(res.error);
    });
  }

  // State 4: attached. PR #199 (Chloe iPad retest): the detach
  // affordance now renders INSIDE the TreatmentPlanBanner via its
  // detachSlot, so the plan card owns the action instead of a link
  // floating below it.
  if (attachedPlan) {
    return (
      <div className="flex flex-col items-start gap-1 text-sm">
        <button
          type="button"
          onClick={submitDetach}
          disabled={pending}
          aria-label={`Detach treatment plan ${attachedPlan.name}`}
          className="text-xs text-neutral-500 underline hover:text-neutral-900 disabled:opacity-50 dark:hover:text-neutral-100"
        >
          Detach from this plan
        </button>
        {error && <p className="text-xs text-red-700">{error}</p>}
      </div>
    );
  }

  // State 1: nothing to attach to
  if (activePlans.length === 0) return null;

  // State 2: one active plan
  if (activePlans.length === 1) {
    const only = activePlans[0];
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => submitAttach(only.id)}
          disabled={pending}
          className="self-start rounded-md border border-dashed border-neutral-300 px-3 py-2 text-sm text-neutral-700 hover:border-neutral-500 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
        >
          + Attach to {only.name}
        </button>
        {error && <p className="text-xs text-red-700">{error}</p>}
      </div>
    );
  }

  // State 3: multiple active plans
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-neutral-500">Attach to:</span>
        <select
          value={picked}
          onChange={(e) => setPicked(e.target.value)}
          className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        >
          {activePlans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => submitAttach(picked)}
          disabled={pending || !picked}
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Attach
        </button>
      </div>
      {error && <p className="text-xs text-red-700">{error}</p>}
    </div>
  );
}
