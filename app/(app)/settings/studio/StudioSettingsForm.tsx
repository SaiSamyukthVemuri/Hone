"use client";

import { useState, useTransition } from "react";
import { updateStudioAction } from "./actions";

type Props = {
  initialName: string;
  initialLegalEntity: string;
  ownerEmail: string;
};

export function StudioSettingsForm({
  initialName,
  initialLegalEntity,
  ownerEmail,
}: Props) {
  const [name, setName] = useState(initialName);
  const [legalEntity, setLegalEntity] = useState(initialLegalEntity);
  const [pending, startTransition] = useTransition();
  const [hint, setHint] = useState<
    { kind: "idle" } | { kind: "saved" } | { kind: "error"; message: string }
  >({ kind: "idle" });

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) {
      setHint({ kind: "error", message: "Studio name is required." });
      return;
    }
    setHint({ kind: "idle" });
    const fd = new FormData();
    fd.set("name", name);
    fd.set("legal_entity_name", legalEntity);

    startTransition(async () => {
      try {
        await updateStudioAction(fd);
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
          Studio name<span className="ml-1 text-red-500">*</span>
        </span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Legal entity name</span>
        <input
          value={legalEntity}
          onChange={(e) => setLegalEntity(e.target.value)}
          placeholder="If different from studio name"
          className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Owner email</span>
        <p className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-3 text-base text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900">
          {ownerEmail}
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
