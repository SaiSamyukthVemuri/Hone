"use client";

import { PendingButton } from "@/components/pending-button";

// Small client component for the booking-settings save button so we
// can show "Saving..." while the server action is in flight and
// disable the button to prevent double-submits. The parent
// <form action={...}> is a Server Action; useFormStatus wires this
// button to that form's pending state automatically (no prop drilling,
// no extra state). Keeps the whole settings page a Server Component.
//
// UI0: the look, the 44px floor, the focus ring and the pending/aria-busy
// wiring come from components/ui/button.tsx.
//
// UI-R01 PROOF CONTROL — the server-action submit.
//
// This file used to BE the pattern: "use client" + useFormStatus + Button.
// That is now components/pending-button.tsx, so this shrinks to a name and a
// label, and the wrapper it used to hand-roll is shared with every other form
// in the app. The client boundary is unchanged — PendingButton is the leaf
// island now, and the settings page stays a Server Component.
//
// `busyLabel="Saving..."` is DELIBERATELY DROPPED. It swapped a 4-character
// label for a 9-character one, which resized the button mid-submit; the recon
// counted 47 controls doing exactly that. Omitting it selects the
// geometry-stable spinner, which sits inside the resting footprint. The state
// is still announced — Button sets aria-busy — so nothing was lost but the jump.
export function SaveButton({ idleLabel }: { idleLabel: string }) {
  return (
    <PendingButton variant="primary">
      {idleLabel}
    </PendingButton>
  );
}
