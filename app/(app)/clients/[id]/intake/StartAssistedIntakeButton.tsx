"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { startAssistedIntakeAction } from "./actions";

// "Start intake with client", the Health & Forms entry point into the
// practitioner-assisted workflow, shown only when the client has no intake on
// file at all.
//
// One click: the server creates a blank in-progress intake (no email: the
// client is in the room) and this navigates straight into the existing #525
// assisted editor. Everything after that point is unchanged: the practitioner
// records steps 1-4, then hands the device over for the client's own
// confirmations and submission.
//
// THE DESTINATION IS THE AUTHENTICATED ROUTE. `/clients/<id>/intake/assist` is
// the practitioner's surface. The client's tokenized `/intake/<token>` link is
// reached only through Hand to client, at the end of the questionnaire, and
// this component could not navigate there if it tried: the action returns an
// intake id and no URL.
// Shown only when the action itself faults: a transport failure, or a server
// error thrown rather than returned. There is no server-authored message in
// that case, so this matches the shape of the ones there are: calm, bounded,
// naming no provider detail, and retryable.
const UNEXPECTED_FAILURE =
  "Could not start an intake for this client. Please try again.";

export function StartAssistedIntakeButton({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // Synchronous latch. `isPending` disables the button, but React sets it a
  // tick after the click, so two fast clicks can both get through the handler
  // before the disabled attribute lands. Same pattern as IntakeReviewForm.
  const inFlight = useRef(false);

  function start() {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    const fd = new FormData();
    fd.set("client_id", clientId);
    startTransition(async () => {
      // Released in `finally` unless we are navigating away. Releasing only on
      // the refusal path would leave the latch shut forever if the action threw
      // instead of returning, and the button would look enabled while being
      // permanently inert.
      let navigating = false;
      try {
        const res = await startAssistedIntakeAction(fd);
        if (!res.ok) {
          // The server result is the only authority, nothing is created
          // optimistically, and a refusal leaves us on Health & Forms.
          setError(res.error);
          return;
        }
        navigating = true;
        router.push(`/clients/${clientId}/intake/assist?intake=${res.intakeId}`);
      } catch {
        setError(UNEXPECTED_FAILURE);
      } finally {
        // On success the latch stays closed while the router navigates away,
        // so a late second click cannot start another intake.
        if (!navigating) inFlight.current = false;
      }
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <button
          type="button"
          onClick={start}
          disabled={isPending}
          data-testid="start-intake-with-client"
          className="inline-flex min-h-[44px] items-center rounded-md bg-neutral-900 px-5 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
        >
          {isPending ? "Starting..." : "Start intake with client"}
        </button>
      </div>
      {error && (
        <p className="text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
