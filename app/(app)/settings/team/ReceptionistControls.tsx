"use client";

import { useState, useTransition } from "react";
import { inviteReceptionistAction, removeReceptionistAccessAction } from "./receptionist-actions";

const field = "rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100";

// Invite a receptionist: creates ONE pending invitation, nothing else (no account, no email, no
// membership). The owner shares the sign-in instruction; the person accepts explicitly.
export function ReceptionistInviteForm() {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "error"; message: string } | { kind: "done"; email: string }>({ kind: "idle" });
  const [pending, start] = useTransition();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData();
    fd.set("email", email);
    fd.set("display_name", displayName);
    start(async () => {
      const r = await inviteReceptionistAction(fd);
      if (!r.ok) return setState({ kind: "error", message: r.error });
      setState({ kind: "done", email: r.email });
      setEmail("");
      setDisplayName("");
    });
  }

  return (
    <form onSubmit={submit} className="flex max-w-xl flex-col gap-3" aria-label="Invite a receptionist">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Email
          <input type="email" required name="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="frontdesk@example.com" className={field} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Display name
          <input name="display_name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Optional" className={field} />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className="rounded-md bg-neutral-900 px-5 py-3 text-base font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900">
          {pending ? "Inviting…" : "Invite receptionist"}
        </button>
        {state.kind === "done" && (
          <p role="status" className="text-sm text-emerald-800 dark:text-emerald-300">
            Invitation created for {state.email}. We do not email it; tell them to sign in with that address.
          </p>
        )}
        {state.kind === "error" && (
          <p role="alert" className="text-sm text-red-800 dark:text-red-200">{state.message}</p>
        )}
      </div>
    </form>
  );
}

// Remove a receptionist's access. Never hidden by the desk flag: the flag hides the desk, only this
// revokes. It also closes any outstanding invitation for the same address (0275).
export function RemoveReceptionistButton({ id, name }: { id: string; name: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        aria-label={`Remove access for ${name}`}
        onClick={() =>
          start(async () => {
            const fd = new FormData();
            fd.set("id", id);
            const r = await removeReceptionistAccessAction(fd);
            setError(r.ok ? null : r.error);
          })
        }
        className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
      >
        {pending ? "Removing…" : "Remove"}
      </button>
      {error && <p role="alert" className="text-xs text-red-800 dark:text-red-200">{error}</p>}
    </div>
  );
}
