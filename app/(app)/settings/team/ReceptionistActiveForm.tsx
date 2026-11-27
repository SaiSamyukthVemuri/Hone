"use client";

import { useState } from "react";
import { PendingButton } from "@/components/pending-button";
import { actionFailureMessage, isActionFailure, type ActionResult } from "@/lib/actions/action-result";

// HON-124 item 20. Deactivate / Reactivate a front-desk member. The action's refusal is shown as a sentence; the confirmation names what
// happened and appears only after the server returned ok (the row's own "inactive" tag re-renders from the revalidated page).
export function ReceptionistActiveForm({ action, receptionistId, name, active }: {
  action: (formData: FormData) => Promise<ActionResult>;
  receptionistId: string;
  name: string;
  active: boolean;
}) {
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  return (
    <form
      action={async (formData) => {
        setMessage(null);
        try {
          const result = await action(formData);
          if (isActionFailure(result)) setMessage({ kind: "error", text: result.error });
          else setMessage({ kind: "ok", text: active ? `Deactivated ${name}.` : `Reactivated ${name}.` });
        } catch (err) {
          setMessage({ kind: "error", text: actionFailureMessage(err, "Could not update this front-desk member. Check your connection and try again.") });
        }
      }}
    >
      <input type="hidden" name="id" value={receptionistId} />
      <input type="hidden" name="active" value={active ? "false" : "true"} />
      <PendingButton variant="secondary" size="sm">{active ? "Deactivate" : "Reactivate"}</PendingButton>
      <p role={message?.kind === "error" ? "alert" : "status"} className="mt-1 text-xs text-neutral-600 empty:hidden dark:text-neutral-400">{message?.text ?? ""}</p>
    </form>
  );
}
