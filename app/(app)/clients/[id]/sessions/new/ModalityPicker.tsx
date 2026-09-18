"use client";

// SESSION-START-01. The press that used to do nothing.
//
// THE DEFECT THIS CLOSES
// ----------------------
// Each modality card was its own server-rendered `<form>` around a raw
// `<button type="submit">`. The page carried no "use client", no
// `useFormStatus`, no disabled state and no pending styling — so when the
// practitioner pressed Electrolysis or Laser, NOTHING on screen was capable of
// changing. The old DOM was held until the server action finished AND the
// charting page rendered. On the linked-appointment path that can be many
// seconds, and the practitioner is left looking at an idle screen.
//
// That is DESIGN.md LAW 4 — "Every control acknowledges immediately. A press is
// confirmed before its result arrives. A control that has been activated must
// never look idle." It was also a double-submit surface: nothing disabled the
// pressed card, so a second press issued a second `start_session`.
//
// ONE FORM, NOT TWO — AND THAT IS THE WHOLE DESIGN
// ------------------------------------------------
// `useFormStatus` only reports the form it is rendered inside. With a form per
// card, the pressed card can know it is busy but its SIBLING cannot, so
// disabling the other modality would need a second, hand-rolled source of truth
// in React state — which then has to be reset by hand on every error path.
//
// Collapsing to ONE form removes that problem instead of managing it. The
// modality rides on the submit button's own `name`/`value`, which is ordinary
// HTML: the browser includes only the button that was actually pressed.
// `startSessionAction` already reads `formData.get("modality")`, so the server
// contract is unchanged.
//
// The result is a single source of truth that resets itself:
//
//   pending                      -> BOTH cards disable (sibling + double submit)
//   data.get("modality")         -> WHICH card shows the spinner
//
// Every failure path in the action `throw`s rather than re-rendering this page,
// and `useFormStatus` clears when the action settles, so there is no state left
// stuck pending. Nothing here needs a manual reset.

import { useFormStatus } from "react-dom";
import { Spinner } from "@/components/ui/spinner";
import {
  cx,
  CONTROL_DISABLED,
  FOCUS_RING,
} from "@/components/ui/control-base";
import { startSessionAction } from "./actions";

type Modality = "electrolysis" | "laser";

const MODALITIES: ReadonlyArray<{
  modality: Modality;
  title: string;
  description: string;
}> = [
  {
    modality: "electrolysis",
    title: "Electrolysis",
    description: "Area, probe, mode, intensity, duration.",
  },
  {
    modality: "laser",
    title: "Laser",
    description: "Zone, fluence, pulse width, spot size.",
  },
];

export function ModalityPicker({
  clientId,
  appointmentId,
}: {
  clientId: string;
  appointmentId: string | null;
}) {
  return (
    <form action={startSessionAction} className="grid gap-4 md:grid-cols-2">
      {/* Shared by both cards — previously duplicated once per form. */}
      <input type="hidden" name="client_id" value={clientId} />
      {appointmentId && (
        <input type="hidden" name="appointment_id" value={appointmentId} />
      )}
      {MODALITIES.map((m) => (
        <ModalityCard key={m.modality} {...m} />
      ))}
    </form>
  );
}

function ModalityCard({
  modality,
  title,
  description,
}: {
  modality: Modality;
  title: string;
  description: string;
}) {
  // Rendered INSIDE the form, which is the only place this hook reports.
  const { pending, data } = useFormStatus();

  // Which card was pressed. `data` is the submitted FormData, so this is the
  // browser's own answer rather than something this component remembered.
  const chosen = pending ? data?.get("modality") : null;
  const isChosen = chosen === modality;

  return (
    <button
      type="submit"
      name="modality"
      value={modality}
      disabled={pending}
      // The VOICE of the pending state. The spinner beside it stays
      // `aria-hidden` (Spinner's default), because a mark that also announced
      // would double-speak — the same pairing Button uses.
      aria-busy={isChosen || undefined}
      data-pending={isChosen ? "true" : undefined}
      data-modality={modality}
      className={cx(
        "flex w-full flex-col items-start gap-2 rounded-lg border border-neutral-200 bg-white px-5 py-6 text-left transition",
        "hover:border-neutral-900 hover:bg-neutral-50",
        "dark:border-neutral-800 dark:bg-neutral-950 dark:hover:border-neutral-100 dark:hover:bg-neutral-900",
        FOCUS_RING,
        CONTROL_DISABLED,
      )}
    >
      <span className="flex w-full items-center gap-2">
        <span className="text-lg font-medium">{title}</span>
        {/* GEOMETRY-STABLE SLOT. `size-4` is reserved whether or not a spinner
            is in it, so the card does not grow or reflow on press — the
            requirement Spinner's fixed square size exists to serve. */}
        <span
          aria-hidden="true"
          className="ml-auto inline-flex size-4 shrink-0 items-center justify-center"
        >
          {isChosen ? <Spinner size="sm" /> : null}
        </span>
      </span>
      {/* THE DESCRIPTION NEVER LEAVES THE FLOW.
          An earlier revision swapped this text for "Starting session…" and
          claimed geometry stability on the strength of the reserved spinner
          slot above. That only stabilised the TITLE row. At 390px the cards
          stack single-column and this description wraps to two lines while
          "Starting session…" fits on one, so the chosen card SHRANK and the
          sibling moved up underneath it — the exact failure the slot exists
          to prevent.

          The fix is the mechanism Button and PendingLink already document:
          hold the real text in flow at opacity-0 so the box cannot resize,
          and overlay the pending words on top of it.

          The description is NOT aria-hidden. Button records why: hiding it
          collapses the control's accessible name to empty for exactly the
          duration it is busy, telling a screen-reader user "busy" about a
          control that no longer says what it is. The OVERLAY is the hidden
          one — it is a visual cue, and aria-busy is what announces. */}
      <span className="relative block w-full text-sm text-neutral-500">
        <span className={isChosen ? "opacity-0" : undefined}>{description}</span>
        {isChosen && (
          <span aria-hidden="true" className="absolute inset-0 flex items-start">
            Starting session…
          </span>
        )}
      </span>
    </button>
  );
}
