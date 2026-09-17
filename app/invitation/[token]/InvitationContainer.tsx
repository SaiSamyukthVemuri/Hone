"use client";

import { useCallback, useState, useTransition } from "react";

import { InvitationScreen } from "@/app/features/waitlist-invitation/InvitationScreen";
import type { InvitationViewState } from "@/lib/waitlist/invitation-offer";
import {
  bookInvitationSlotAction,
  declineInvitationAction,
  loadInvitationAction,
  requestInvitationProofAction,
  submitInvitationProofAction,
} from "./actions";

// WAIT-03 B3 — the container.
//
// It holds an `InvitationViewState` and nothing else. Every action returns a
// fresh one, computed on the server, so this component never sees a
// `ResolveOutcome`, the proof code, the capability or the challenge id -- there
// is no client state for any of them to live in.
//
// The token IS in this component, because it is in the URL the recipient is
// already looking at. It is not authority: possession of it reaches the offer
// and the proof request, and nothing else.

export function InvitationContainer({
  token,
  initial,
}: {
  token: string;
  initial: InvitationViewState;
}) {
  const [state, setState] = useState<InvitationViewState>(initial);
  const [selectedSlotStart, setSelectedSlotStart] = useState<string | null>(null);
  /**
   * Only ever read when the offer says the entry has no stored phone. Held here
   * rather than in the screen so a re-render carrying a refusal does not wipe
   * what the recipient typed — losing it would make a failed Book cost them the
   * number as well as the attempt.
   */
  const [typedPhone, setTypedPhone] = useState("");
  const [pending, startTransition] = useTransition();

  /** Every action funnels through here so `pending` can never be left stuck on. */
  const run = useCallback((op: () => Promise<InvitationViewState>) => {
    startTransition(async () => {
      try {
        const next = await op();
        setState(next);
        // A SELECTION MUST NOT OUTLIVE THE SLOT IT POINTS AT.
        //
        // Every refreshed offer is a new availability read. When the chosen
        // instant was taken while the recipient was deciding, it is simply
        // absent from the new day list — but `selectedSlotStart` survived the
        // state swap, so nothing appeared selected while Book stayed enabled,
        // and pressing it resubmitted the vanished slot for the same refusal,
        // forever. Clearing it here rather than in the Book handler covers the
        // retry and reload paths too, which refresh availability just as much.
        setSelectedSlotStart((current) => {
          if (current === null) return null;
          if (next.kind !== "offer") return null;
          const stillOffered = next.days.some((d) =>
            d.slots.some((s) => s.start === current),
          );
          return stillOffered ? current : null;
        });
      } catch {
        // A thrown action is a transport failure, not a refusal. Say so, and
        // leave a retry path rather than a dead screen.
        setState({ kind: "error", retryable: true });
        setSelectedSlotStart(null);
      }
    });
  }, []);

  /**
   * The masked contact and expiry the recipient is currently looking at. A code
   * submission carries them back so a failure can keep showing where the code
   * went instead of blanking mid-exchange.
   */
  const proofContext =
    state.kind === "proof" &&
    (state.stage.kind === "sent" ||
      state.stage.kind === "verifying" ||
      state.stage.kind === "failed")
      ? { maskedContact: state.stage.maskedContact, expiresAt: state.stage.expiresAt }
      : { maskedContact: "", expiresAt: "" };

  return (
    <InvitationScreen
      state={state}
      selectedSlotStart={selectedSlotStart}
      typedPhone={typedPhone}
      onTypedPhoneChange={setTypedPhone}
      pending={pending}
      onSelectSlot={(slot) => setSelectedSlotStart(slot.start)}
      onRetry={() => run(() => loadInvitationAction(token))}
      onRequestCode={() => run(() => requestInvitationProofAction(token))}
      onSubmitCode={(code: string) =>
        run(() => submitInvitationProofAction(token, code, proofContext))
      }
      onBook={() => {
        if (!selectedSlotStart) return;
        // The typed number is sent unconditionally and IGNORED by the action
        // wherever the entry already has one. The server decides which value
        // reaches the booking, so a crafted client cannot substitute a phone
        // onto an entry whose own number the studio already holds.
        run(() => bookInvitationSlotAction(token, selectedSlotStart, typedPhone));
      }}
      onDecline={() => run(() => declineInvitationAction(token))}
    />
  );
}
