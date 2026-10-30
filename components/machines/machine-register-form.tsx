"use client";

import { useState, useTransition } from "react";

export type RegisterableModel = { profileId: string; label: string };

export type RegisterResult = { ok: boolean; error?: string };

type Props = {
  models: ReadonlyArray<RegisterableModel>;
  /** The server action. Passed in so the form never imports server code. */
  register: (input: {
    profileId: string;
    displayName: string;
  }) => Promise<RegisterResult>;
};

/** Pure, so the rule is testable without a DOM. */
export function registrationProblem(
  profileId: string,
  displayName: string,
  models: ReadonlyArray<RegisterableModel>,
): string | null {
  if (!models.some((m) => m.profileId === profileId)) {
    return "Choose one of the listed models.";
  }
  const name = displayName.trim();
  if (name.length === 0 || name.length > 80) {
    return "Give the machine a name between 1 and 80 characters.";
  }
  return null;
}

export function MachineRegisterForm({ models, register }: Props) {
  const [profileId, setProfileId] = useState(models[0]?.profileId ?? "");
  const [displayName, setDisplayName] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [pending, startTransition] = useTransition();

  if (models.length === 0) {
    return (
      <p
        className="text-sm text-neutral-600 dark:text-neutral-400"
        data-testid="machine-register-none"
      >
        No machine model has passed its evidence review yet, so there is
        nothing to register. To have yours reviewed, send Hone the details
        listed above.
      </p>
    );
  }

  function submit() {
    const problem = registrationProblem(profileId, displayName, models);
    if (problem) {
      setMessage({ ok: false, text: problem });
      return;
    }
    startTransition(async () => {
      const res = await register({ profileId, displayName: displayName.trim() });
      if (res.ok) {
        setMessage({ ok: true, text: "Machine registered." });
        setDisplayName("");
      } else {
        setMessage({
          ok: false,
          text: res.error ?? "The machine could not be registered.",
        });
      }
    });
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-testid="machine-register-form"
    >
      <div>
        <label htmlFor="machine-model" className="block text-sm font-medium">
          Model
        </label>
        <select
          id="machine-model"
          value={profileId}
          onChange={(e) => setProfileId(e.target.value)}
          disabled={pending}
          className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
        >
          {models.map((m) => (
            <option key={m.profileId} value={m.profileId}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor="machine-name" className="block text-sm font-medium">
          Name for this unit
        </label>
        <input
          id="machine-name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={80}
          disabled={pending}
          placeholder="For example, the room it lives in"
          className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
        data-testid="machine-register-submit"
      >
        {pending ? "Registering..." : "Register machine"}
      </button>
      {message && (
        <p
          role="status"
          className={
            message.ok
              ? "text-sm text-green-700 dark:text-green-400"
              : "text-sm text-red-700 dark:text-red-400"
          }
          data-testid="machine-register-message"
        >
          {message.text}
        </p>
      )}
    </form>
  );
}
