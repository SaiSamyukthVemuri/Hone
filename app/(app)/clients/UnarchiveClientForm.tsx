"use client";

import { useState } from "react";
import { PendingButton } from "@/components/pending-button";
import { actionFailureMessage, isActionFailure, type ActionResult } from "@/lib/actions/action-result";

// HON-124 item 20. The unarchive form shared by the client list row and the edit page. The action redirects to the client on success (that is
// the confirmation, shown only after the write); a refusal comes back as a sentence and is shown here instead of a redacted thrown message.
export function UnarchiveClientForm({ action, clientId, variant, size, busyLabel, children }: {
  action: (formData: FormData) => Promise<ActionResult>;
  clientId: string;
  variant: "primary" | "secondary";
  size?: "sm";
  busyLabel?: string;
  children: React.ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      action={async (formData) => {
        setError(null);
        try {
          const result = await action(formData);
          if (isActionFailure(result)) setError(result.error);
        } catch (err) {
          // A successful unarchive redirects; that is a redirect signal, not a failure.
          if (String((err as { digest?: unknown } | null)?.digest ?? "").startsWith("NEXT_REDIRECT")) throw err;
          setError(actionFailureMessage(err, "Could not unarchive this client. Check your connection and try again."));
        }
      }}
    >
      <input type="hidden" name="client_id" value={clientId} />
      <PendingButton variant={variant} size={size} busyLabel={busyLabel}>
        {children}
      </PendingButton>
      {error ? <p role="alert" className="mt-1 text-xs text-danger-solid">{error}</p> : null}
    </form>
  );
}
