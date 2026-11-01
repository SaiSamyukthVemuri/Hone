"use client";

import { useState, useTransition } from "react";
import { updateStudioAction } from "./actions";
import { SaveStatus, useSaveFeedback } from "@/components/settings/save-status";
import { useUnsavedChangesGuard } from "@/components/settings/unsaved-changes";

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
  const [saved, setSaved] = useState({ name: initialName, legalEntity: initialLegalEntity });
  const [pending, startTransition] = useTransition();
  const feedback = useSaveFeedback();

  const dirty = name !== saved.name || legalEntity !== saved.legalEntity;
  useUnsavedChangesGuard("studio-details", dirty);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) {
      feedback.failed("Studio name is required.");
      return;
    }
    feedback.saving();
    const fd = new FormData();
    fd.set("name", name);
    fd.set("legal_entity_name", legalEntity);

    startTransition(async () => {
      try {
        await updateStudioAction(fd);
        setSaved({ name, legalEntity });
        feedback.saved();
      } catch (err) {
        feedback.failed(err instanceof Error ? err.message : "Failed to save.");
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex max-w-xl flex-col gap-5">
      <label id="studio-name" className="flex scroll-mt-24 flex-col gap-1.5">
        <span className="text-sm font-medium">
          Studio name<span className="ml-1 text-red-500">*</span>
        </span>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            feedback.reset();
          }}
          required
          className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
      </label>

      <label id="legal-entity" className="flex scroll-mt-24 flex-col gap-1.5">
        <span className="text-sm font-medium">Legal entity name</span>
        <input
          value={legalEntity}
          onChange={(e) => {
            setLegalEntity(e.target.value);
            feedback.reset();
          }}
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
        <SaveStatus state={feedback.state} />
      </div>
    </form>
  );
}
