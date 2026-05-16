"use client";

import { useState, useTransition } from "react";
import { updateOwnProfileAction } from "./actions";

type Props = {
  initialDisplayName: string;
  email: string;
};

export function ProfileForm({ initialDisplayName, email }: Props) {
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [pending, startTransition] = useTransition();
  const [hint, setHint] = useState<
    { kind: "idle" } | { kind: "saved" } | { kind: "error"; message: string }
  >({ kind: "idle" });

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!displayName.trim()) {
      setHint({ kind: "error", message: "Your name is required." });
      return;
    }
    setHint({ kind: "idle" });
    const fd = new FormData();
    fd.set("display_name", displayName);

    startTransition(async () => {
      try {
        await updateOwnProfileAction(fd);
        setHint({ kind: "saved" });
        window.setTimeout(() => setHint({ kind: "idle" }), 1500);
      } catch (err) {
        setHint({
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to save.",
        });
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex max-w-xl flex-col gap-5">
      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">
          Your name<span className="ml-1 text-red-500">*</span>
        </span>
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
          placeholder="The name your team will see"
          className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
        <span className="text-xs text-neutral-500">
          Shown next to sessions you perform and in the team roster.
        </span>
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Email</span>
        <p className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-3 text-base text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900">
          {email}
        </p>
      </div>

      <div className="mt-2 flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-neutral-900 px-5 py-3 text-base font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {pending ? "Saving" : "Save"}
        </button>
        {hint.kind === "saved" && (
          <span className="text-sm text-green-600 dark:text-green-400">
            Saved
          </span>
        )}
        {hint.kind === "error" && (
          <span className="text-sm text-red-600 dark:text-red-400">
            {hint.message}
          </span>
        )}
      </div>
    </form>
  );
}
