"use client";

import { useState } from "react";
import { actionFailureMessage, isActionFailure, type ActionResult } from "@/lib/actions/action-result";

// HON-124 item 20. "Mark as reviewed" on the client portal. The action used to return silently on any failure and leave an unchanged button.
// A refusal is now said; success re-renders the page with the "Reviewed" badge (revalidatePath in the action), which is the confirmation.
export function PortalReviewedForm({ action, messageId }: { action: (formData: FormData) => Promise<ActionResult>; messageId: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      action={async (formData) => {
        setError(null);
        try {
          const result = await action(formData);
          if (isActionFailure(result)) setError(result.error);
        } catch (err) {
          setError(actionFailureMessage(err, "Could not mark this message as reviewed. Check your connection and try again."));
        }
      }}
    >
      <input type="hidden" name="message_id" value={messageId} />
      <button
        type="submit"
        className="px-5 py-2 text-[12px] font-medium uppercase"
        style={{ backgroundColor: "#0A0A0A", color: "#FAFAF7", letterSpacing: "0.1em" }}
      >
        Mark as reviewed
      </button>
      {error ? <p role="alert" className="mt-2 text-[13px]" style={{ color: "#8A2B1F" }}>{error}</p> : null}
    </form>
  );
}
