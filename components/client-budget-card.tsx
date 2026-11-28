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

import { useActionState, useRef, useState } from "react";
import { latestDraft, type DraftActions } from "@/lib/note-drafts/draft-registry";
import { useNoteDraft } from "@/lib/note-drafts/use-note-draft";
import { NoteDraftStatus } from "@/components/note-draft-status";
import type { NoteDraftFields, NoteDraftKey, NoteDraftSaveResult, StoredNoteDraft } from "@/lib/note-drafts/types";
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

// Shown when the budget read FAILED (permission, RLS, network, timeout —
// anything that is not the proven migration-skew condition). It renders no
// textarea, no chips and no Save button, because the whole hazard is a blank
// editable form that a practitioner saves over their real data. Consultation
// notes and Skin & hair analysis are separate cards and stay usable.
export function ClientBudgetCardUnavailable() {
  return (
    <section
      aria-labelledby="client-budget-heading"
      className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800"
    >
      <h2
        id="client-budget-heading"
        className="text-sm font-medium uppercase tracking-wider text-neutral-500"
      >
        Budget
      </h2>
      <p role="alert" className="text-sm text-neutral-700 dark:text-neutral-300">
        Budget information could not be loaded. Try again.
      </p>
      <p className="text-xs text-neutral-500">
        Nothing has been changed. Any budget already saved for this client is
        still there. Reload the page to try again.
      </p>
    </section>
  );
}

export function ClientBudgetCard({
  clientId,
  initial,
  action,
  draft: restored = null,
  draftActions,
}: {
  draft?: StoredNoteDraft | null;
  draftActions?: DraftActions;
  clientId: string;
  initial: {
    budgetLevel: ClientBudgetLevel | null;
    budgetNotes: string;
  };
  action: (
    formData: FormData,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const draftKey: NoteDraftKey = { clientId, kind: "budget", target: "current" };
  // Start from the NEWEST text this tab knows (held after a failed flush, or saved since the page loaded), else the page's stored draft.
  const [start] = useState(() => (draftActions ? latestDraft(draftKey, restored, draftActions.scope) : null));
  const [level, setLevel] = useState<ClientBudgetLevel | null>(
    (start?.fields.budget_level as ClientBudgetLevel | undefined) ?? initial.budgetLevel,
  );
  // HON-130: budget draft. The saved record is written only by the Save button; the same transaction clears the draft.
  const [budgetText, setBudgetText] = useState(start?.fields.budget_notes ?? initial.budgetNotes);
  // Uncontrolled textarea (defaultValue, as before); a reset remounts it with a new key.
  const [notesInit, setBudgetInit] = useState(budgetText);
  const [notesKey, setNotesKey] = useState(0);
  function resetBudgetText(next: string) {
    setBudgetText(next);
    setBudgetInit(next);
    setNotesKey((k) => k + 1);
  }
  const draft = useNoteDraft(draftKey, restored, draftActions ?? { scope: "none", save: async () => ({ status: "error" }), discard: async () => ({ ok: false }), peek: async () => ({ ok: false, draft: null }) }, Boolean(draftActions));
  const [restoredAt, setRestoredAt] = useState<string | null>(start && !start.unsaved ? start.savedAt : null);
  // Use theirs replaces the card with the other window's draft: what the person had typed stays on screen here until they dismiss it.
  const [yourVersion, setYourVersion] = useState<{ level: ClientBudgetLevel | null; notes: string } | null>(null);
  // A chip change is a draft change too, reported from the PRESS handler (never from an effect on `level`): a programmatic reset (a discard, or adopting
  // the other window's level) changes `level` without being a typed change and must never start an autosave that would bring the draft back.
  function chooseLevel(next: ClientBudgetLevel | null) {
    setLevel(next);
    touch({ level: next });
  }
  // The card's CURRENT values, kept fresh every render, for the moment a failed Discard resumes (its closure is older than the typing).
  const currentFields = useRef<NoteDraftFields>({ budget_level: level ?? "", budget_notes: budgetText });
  currentFields.current = { budget_level: level ?? "", budget_notes: budgetText };
  function touch(next: { level?: ClientBudgetLevel | null; notes?: string }) {
    // While the real Save is pending the card is locked (below). An edit that still arrives (a script, an assistive tool) is not taken: it would
    // reach the draft but not the submitted FormData, and the settle that follows a successful Save would then delete it unseen.
    if (!draftActions || savePending || draft.discarding) return;
    setRestoredAt(null);
    const l = next.level !== undefined ? next.level : level;
    draft.change({ budget_level: l ?? "", budget_notes: next.notes ?? budgetText });
  }

  const [state, formAction, savePending] = useActionState(
    async (
      _prev: BudgetCardActionState,
      formData: FormData,
    ): Promise<BudgetCardActionState> => {
      const r = await action(formData);
      if (!r.ok) return { status: "error", message: r.error };
      draft.settle(); // the save cleared the draft in its own transaction
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
      {/* The draft lifecycle this Save ends (same transaction). Empty when autosave is off. */}
      <input type="hidden" name="draft_generation" value={draft.generation() ?? ""} />

      <header className="flex flex-col gap-1">
        <h2
          id="client-budget-heading"
          className="text-sm font-medium uppercase tracking-wider text-neutral-500"
        >
          Budget
        </h2>
        <p className="text-xs text-neutral-500">
          Record financial preferences or limits that can affect how you plan
          treatment. Practitioner-only. Never shown to the client.
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
                disabled={savePending || draft.discarding}
                onClick={() => chooseLevel(selected ? null : value)}
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
              disabled={savePending || draft.discarding}
              onClick={() => chooseLevel(null)}
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
          key={notesKey}
          readOnly={savePending || draft.discarding}
          defaultValue={notesInit}
          onChange={(e) => {
            setBudgetText(e.target.value);
            touch({ notes: e.target.value });
          }}
          rows={5}
          maxLength={MAX_BUDGET_NOTE_LENGTH}
          placeholder="Anything that shapes how you plan: preferred spend per visit, saving for a specific area, wants to spread sessions out…"
          className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
      </div>

      {yourVersion !== null && (
        <div className="rounded-md border border-neutral-300 p-2 text-xs" data-testid="budget-draft-your-version">
          <p className="font-medium">Your version (not saved in the draft)</p>
          <p>{yourVersion.level ? CLIENT_BUDGET_LEVEL_LABELS[yourVersion.level] : "No level"}</p>
          <pre className="whitespace-pre-wrap">{yourVersion.notes}</pre>
          <button type="button" onClick={() => setYourVersion(null)} className="min-h-[44px] underline">
            Dismiss
          </button>
        </div>
      )}
      {draftActions && (
        <NoteDraftStatus
          state={draft.state}
          restoredAt={restoredAt}
          onRetry={draft.retry}
          onKeepMine={draft.keepMine}
          onKeepAsNew={draft.keepAsNew}
          discardFailed={draft.discardFailed}
          discarding={draft.discarding}
          onUseTheirs={() => {
            const t = draft.useTheirs();
            if (t) {
              setYourVersion({ level, notes: budgetText });
              if (t.budget_notes !== undefined) resetBudgetText(t.budget_notes);
              if (t.budget_level !== undefined) {
                setLevel((t.budget_level || null) as ClientBudgetLevel | null); // adopting the other window's level is not a typed change
              }
            }
          }}
          onDiscard={async () => {
            if (!(await draft.discard())) {
              // Failed: the card stays exactly as it was and the status says so. Text that reached the form in the one frame before the lock
              // rendered never reached the saver (edits are ignored while a Discard is out): hand the CURRENT values over so they are sent.
              const cur = currentFields.current;
              if (JSON.stringify(cur) !== JSON.stringify(draft.latest())) draft.change(cur);
              return;
            }
            setRestoredAt(null);
            resetBudgetText(initial.budgetNotes);
            setLevel(initial.budgetLevel); // a reset is not a typed change: nothing reports it, so it cannot start an autosave
          }}
        />
      )}

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
