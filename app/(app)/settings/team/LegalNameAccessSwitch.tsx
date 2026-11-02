"use client";

import { useState, useTransition } from "react";
import { setReceptionistLegalNameAccessAction } from "./legal-name-access-actions";

// HON-58 Q1: owner-only. Default OFF. Receptionists always see the preferred name, or the stored
// name labelled "Name on file"; this switch is the only thing that lets them see a legal name.
export function LegalNameAccessSwitch({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(next: boolean) {
    setMessage(null);
    const fd = new FormData();
    fd.set("enabled", next ? "on" : "off");
    if (next) fd.set("confirm", confirm ? "yes" : "no");
    startTransition(async () => {
      try {
        const r = await setReceptionistLegalNameAccessAction(fd);
        if (r.ok) {
          setEnabled(r.receptionistAccess);
          setConfirm(false);
          setMessage({ kind: "ok", text: r.receptionistAccess ? "Saved. Receptionists are allowed to see legal names once a screen shows them." : "Saved. Receptionists are not allowed to see legal names." });
        } else {
          setMessage({ kind: "error", text: r.error });
        }
      } catch {
        setMessage({ kind: "error", text: "Couldn't change this setting. Please try again." });
      }
    });
  }

  return (
    <div className="flex flex-col gap-3" data-testid="legal-name-access">
      <p className="text-sm" data-testid="legal-name-access-state">
        Receptionists allowed to see legal names: <strong>{enabled ? "On" : "Off"}</strong>
      </p>
      {enabled ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => submit(false)}
          className="self-start rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          {pending ? "Saving…" : "Turn off"}
        </button>
      ) : (
        <>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
            <span>I understand that once a receptionist screen shows legal names, receptionists will see every client&rsquo;s legal name.</span>
          </label>
          <button
            type="button"
            disabled={pending || !confirm}
            onClick={() => submit(true)}
            className="self-start rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60 dark:bg-white dark:text-neutral-900"
          >
            {pending ? "Saving…" : "Turn on"}
          </button>
        </>
      )}
      {message && (
        <p role="status" className={message.kind === "ok" ? "text-sm text-green-700" : "text-sm text-red-700"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
