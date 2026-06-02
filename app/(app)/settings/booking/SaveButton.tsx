"use client";

import { useFormStatus } from "react-dom";

// Small client component for the booking-settings save button so we
// can show "Saving..." while the server action is in flight and
// disable the button to prevent double-submits. The parent
// <form action={...}> is a Server Action; useFormStatus wires this
// button to that form's pending state automatically (no prop drilling,
// no extra state). Keeps the whole settings page a Server Component.
export function SaveButton({ idleLabel }: { idleLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
    >
      {pending ? "Saving..." : idleLabel}
    </button>
  );
}
