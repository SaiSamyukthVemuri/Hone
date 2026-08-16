"use client";

// CLIENT BUDGET CONTEXT card.
//
// Renders on the Consultation & Skin/Hair tab as a peer of "Consultation
// notes" and "Skin & hair analysis", but it is explicitly NOT a clinical
// note: it is mutable current context (one row per client, overwritten on
// save), not an append-only dated clinical record.
//
// Bound to updateClientBudgetContextAction via <form action>. The three
// levels are toggle buttons rather than a radio group so a practitioner can
// UNSET a level (press the selected chip again, or use Clear) and return the
// client to "no broad level recorded" — a radio group has no native way back
// to nothing. Each chip is a real <button>, so Tab/Enter/Space work without
// custom key handling, and aria-pressed announces the selection.
//
// The chip and the free text are INDEPENDENT: either can exist without the
// other, and selecting a chip never writes boilerplate into the textarea.
//
// This component is rendered ONLY on the authenticated client profile page
// (app/(app)/clients/[id]/page.tsx) under the "consultation" tab. It must NOT
// be imported by app/book/*, app/portal/*, lib/email/*, lib/sms/*,
// app/intake/*, app/cancel/*, app/reschedule/*, app/api/cron/* or
// app/api/stripe/*.

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  CLIENT_BUDGET_LEVELS,
  CLIENT_BUDGET_LEVEL_LABELS,
  MAX_BUDGET_NOTE_LENGTH,
  type ClientBudgetLevel,
} from "@/lib/budget/levels";

export type BudgetCardActionState =
  | { status: "idle" }
  | { status: "saved"; at: number }
  | { status: "error"; message: string };

const INITIAL_STATE: BudgetCardActionState = { status: "idle" };

export function ClientBudgetCard({
  clientId,
  initial,
  action,
}: {
  clientId: string;
  initial: {
    budgetLevel: ClientBudgetLevel | null;
    budgetNotes: string;
  };
  action: (
    formData: FormData,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [level, setLevel] = useState<ClientBudgetLevel | null>(
    initial.budgetLevel,
  );

  const [state, formAction] = useActionState(
    async (
      _prev: BudgetCardActionState,
      formData: FormData,
    ): Promise<BudgetCardActionState> => {
      const r = await action(formData);
      if (!r.ok) return { status: "error", message: r.error };
      return { status: "saved", at: Date.now() };
    },
    INITIAL_STATE,
  );

  return (
    <form
      action={formAction}
      aria-labelledby="client-budget-heading"
      className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"
    >
      <input type="hidden" name="client_id" value={clientId} />
      {/* The level travels as a hidden field so the chips stay plain
          buttons. An empty string means "no broad level recorded"; the
          server action treats absent and empty identically. */}
      <input type="hidden" name="budget_level" value={level ?? ""} />

      <header className="flex flex-col gap-1">
        <h2
          id="client-budget-heading"
          className="text-sm font-medium uppercase tracking-wider text-neutral-500"
        >
          Budget
        </h2>
        <p className="text-xs text-neutral-500">
          Record financial preferences or limits that can affect how you plan
          treatment. Practitioner-only — never shown to the client.
        </p>
      </header>

      <div className="flex flex-col gap-2">
        <div
          role="group"
          aria-label="Budget level"
          className="flex flex-wrap gap-2"
        >
          {CLIENT_BUDGET_LEVELS.map((value) => {
            const selected = level === value;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={selected}
                onClick={() => setLevel(selected ? null : value)}
                // min-h-11 == 44px: the iPad/phone touch-target floor.
                className={
                  selected
                    ? "min-h-11 rounded-full border border-neutral-900 bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:border-white dark:bg-white dark:text-neutral-900"
                    : "min-h-11 rounded-full border border-neutral-300 bg-white px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-900"
                }
              >
                {CLIENT_BUDGET_LEVEL_LABELS[value]}
              </button>
            );
          })}
        </div>
        {level !== null && (
          <div>
            <button
              type="button"
              onClick={() => setLevel(null)}
              className="text-xs text-neutral-500 underline underline-offset-2 hover:text-neutral-900 dark:hover:text-neutral-100"
            >
              Clear budget level
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <label
          htmlFor="client-budget-notes"
          className="text-sm font-medium text-neutral-800 dark:text-neutral-200"
        >
          Budget notes
        </label>
        <textarea
          id="client-budget-notes"
          name="budget_notes"
          defaultValue={initial.budgetNotes}
          rows={5}
          maxLength={MAX_BUDGET_NOTE_LENGTH}
          placeholder="Anything that shapes how you plan: preferred spend per visit, saving for a specific area, wants to spread sessions out…"
          className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
      </div>

      <footer className="flex flex-wrap items-center justify-end gap-3">
        {state.status === "error" && (
          <p role="alert" className="text-xs text-red-700 dark:text-red-400">
            {state.message}
          </p>
        )}
        {state.status === "saved" && (
          <p className="text-xs text-emerald-700 dark:text-emerald-400">
            Saved.
          </p>
        )}
        <SaveButton />
      </footer>
    </form>
  );
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="min-h-11 rounded-md bg-neutral-900 px-5 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
    >
      {pending ? "Saving…" : "Save budget"}
    </button>
  );
}
