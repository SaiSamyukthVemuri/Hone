"use client";

import { useFormStatus } from "react-dom";

import { Button } from "@/components/ui/button";

// Small client component for the booking-settings save button so we
// can show "Saving..." while the server action is in flight and
// disable the button to prevent double-submits. The parent
// <form action={...}> is a Server Action; useFormStatus wires this
// button to that form's pending state automatically (no prop drilling,
// no extra state). Keeps the whole settings page a Server Component.
//
// UI0: the look, the 44px floor, the focus ring and the pending/aria-busy
// wiring now come from components/ui/button.tsx. This file keeps the ONE
// thing that genuinely needs a client boundary — reading the parent form's
// pending state — and nothing else. The Button itself carries no directive,
// so it stays usable from Server Components elsewhere.
export function SaveButton({ idleLabel }: { idleLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" pending={pending} busyLabel="Saving...">
      {idleLabel}
    </Button>
  );
}
