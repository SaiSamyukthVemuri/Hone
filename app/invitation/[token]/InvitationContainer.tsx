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
  const [pending, startTransition] = useTransition();

  /** Every action funnels through here so `pending` can never be left stuck on. */
  const run = useCallback((op: () => Promise<InvitationViewState>) => {
    startTransition(async () => {
      try {
        setState(await op());
      } catch {
        // A thrown action is a transport failure, not a refusal. Say so, and
        // leave a retry path rather than a dead screen.
        setState({ kind: "error", retryable: true });
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
      pending={pending}
      onSelectSlot={(slot) => setSelectedSlotStart(slot.start)}
      onRetry={() => run(() => loadInvitationAction(token))}
      onRequestCode={() => run(() => requestInvitationProofAction(token))}
      onSubmitCode={(code: string) =>
        run(() => submitInvitationProofAction(token, code, proofContext))
      }
      onBook={() => {
        if (!selectedSlotStart) return;
        run(() => bookInvitationSlotAction(token, selectedSlotStart));
      }}
      onDecline={() => run(() => declineInvitationAction(token))}
    />
  );
}
