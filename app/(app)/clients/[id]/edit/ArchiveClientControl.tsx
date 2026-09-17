"use client";

import { useState } from "react";

import { PendingButton } from "@/components/pending-button";
import { Button } from "@/components/ui/button";
import {
  CONTROL_MIN_TOUCH,
  FOCUS_RING,
  LEAF_CONTROL_PRESS,
  cx,
} from "@/components/ui/control-base";
import { archiveClientAction } from "../actions";

// Two-step archive control. The first click reveals the confirmation
// copy and a primary "Archive" submit; the second click actually
// archives. The Cancel button disarms. This is the safest small-PR
// equivalent of a "type the client's name to confirm" modal -- it
// stops a single misclick from hiding a real client, without adding
// a new modal component.
//
// The action redirects to /clients on success so the practitioner
// lands on the active list and immediately sees the archived row is
// gone. The "Historical records may remain" copy makes the
// non-destructive nature of archive explicit.
//
// UI-R02 — WHAT CHANGED, AND WHY A DESTRUCTIVE CONTROL WAS WORTH THE SLICE
//
// All three controls were raw <button>s with `hover:` and nothing else: no
// `active:`, no `focus-visible:`, and `px-3 py-2 text-sm` — about 36px, under
// the 44px floor. On the one control whose entire job is to stop a misclick
// from hiding a real client, an under-floor touch target and a dead press are
// the wrong two defects to have together.
//
// `ArchiveSubmit` was also a hand-rolled PendingButton: `useFormStatus()`, a
// `{pending ? "Archiving..." : "Archive client"}` ternary and
// `disabled:opacity-60`. Button's docblock counts 57 of those ternaries across
// 47 files; this is one of them, and it now uses the primitive that owns the
// behaviour — including the geometry-stable spinner, so the control cannot
// change width mid-archive.
export function ArchiveClientControl({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const [arming, setArming] = useState(false);

  if (!arming) {
    return (
      // NOT a Button, deliberately. Hone's Button has four variants and none of
      // them is outlined-danger: `danger` is SOLID red, and using it here would
      // flatten the escalation this control is built on — outlined while
      // disarmed, solid once armed. Hone also ships no tailwind-merge, so a
      // `className` cannot reliably beat a variant's own background.
      //
      // So this composes the shared layers directly, which is exactly the
      // documented contract of LEAF_CONTROL_PRESS: it carries NO colour of its
      // own, and the caller supplies one for a family Button does not cover.
      // Under reduced motion the scale collapses to a no-op, which is why the
      // red `active:` fill below is required rather than decorative.
      //
      // Arming is not itself destructive — it only reveals copy — so the
      // quieter outlined treatment is the honest one.
      <button
        type="button"
        onClick={() => setArming(true)}
        className={cx(
          CONTROL_MIN_TOUCH,
          FOCUS_RING,
          LEAF_CONTROL_PRESS,
          "rounded-md border border-red-300 px-3 text-sm font-medium text-red-700",
          "hover:bg-red-50 active:bg-red-100",
          "dark:border-red-700/60 dark:text-red-300 dark:hover:bg-red-950/30 dark:active:bg-red-900/40",
        )}
      >
        Archive client
      </button>
    );
  }

  return (
    <form
      action={archiveClientAction}
      className="flex flex-col gap-3 rounded-md border border-red-300 bg-red-50 p-4 dark:border-red-700/60 dark:bg-red-950/20"
    >
      <input type="hidden" name="client_id" value={clientId} />
      <p className="text-sm font-medium text-red-900 dark:text-red-100">
        Archive {clientName}?
      </p>
      <p className="text-xs text-red-900/80 dark:text-red-100/80">
        This hides the client from active lists. Historical records
        may remain (past appointments, sessions, intake, audit). You
        can unarchive later from this page.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {/* The real destructive step, and the only solid-danger control here.
            `busyLabel` keeps an accessible name while the action is in flight —
            the label never empties, and aria-busy is what announces the state. */}
        <PendingButton variant="danger" busyLabel="Archiving…">
          Archive client
        </PendingButton>
        <Button type="button" variant="secondary" onClick={() => setArming(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
