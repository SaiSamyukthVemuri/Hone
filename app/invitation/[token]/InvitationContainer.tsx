"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import { InvitationScreen } from "@/app/features/waitlist-invitation/InvitationScreen";
import type { InvitationViewState } from "@/lib/waitlist/invitation-offer";
import {
  bookInvitationSlotAction,
  declineInvitationAction,
  loadInvitationAction,
  timesDontWorkAction,
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

/** Background refresh on tab return runs at most this often. */
export const REFRESH_MIN_INTERVAL_MS = 30_000;
/** A background read that has not answered by now is abandoned; the offer stays. */
export const REFRESH_TIMEOUT_MS = 15_000;

export function InvitationContainer({
  token,
  initial,
  timesFeedback = false,
}: {
  token: string;
  initial: InvitationViewState;
  /** 0319: server-evaluated flag. False keeps the existing decline only. */
  timesFeedback?: boolean;
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
  /** Bumped by every user action; a background read must land in the epoch it began in. */
  const epoch = useRef(0);

  /** Adopt a fresh view state, dropping a selection the new offer no longer lists. */
  const applyState = useCallback((next: InvitationViewState) => {
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
  }, []);

  /** Every action funnels through here so `pending` can never be left stuck on. */
  const run = useCallback(
    (op: () => Promise<InvitationViewState>) => {
      // Every user action starts a new epoch, so a background read begun before
      // it can be recognised as stale when it lands.
      epoch.current += 1;
      startTransition(async () => {
        try {
          applyState(await op());
        } catch {
          // A thrown action is a transport failure, not a refusal. Say so, and
          // leave a retry path rather than a dead screen.
          setState({ kind: "error", retryable: true });
          setSelectedSlotStart(null);
        }
      });
    },
    [applyState],
  );

  // REFRESH ON RETURN. A tab left open while the recipient decides can show times
  // that have since gone. Coming back to it re-reads the offer (a fresh
  // availability read on the server).
  //
  //   * ONLY ON AN OFFER, never while an action is running, and at most once per
  //     REFRESH_MIN_INTERVAL_MS, so flicking between tabs is not a read loop.
  //   * A FAILED background read KEEPS WHAT IS ON SCREEN. Only an explicit
  //     "Check again" may replace the offer with the retry error: a recipient
  //     who is halfway through typing must not lose the page to a blip.
  //   * A result that lands after an action started or finished is DISCARDED
  //     (per-action epoch, and the screen must still be an offer), so a stale
  //     read cannot overwrite a booking or decline.
  const latest = useRef({ kind: state.kind, pending });
  latest.current = { kind: state.kind, pending };
  const lastRefreshAt = useRef(0);
  const readInFlight = useRef(false);
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (latest.current.kind !== "offer" || latest.current.pending) return;
      // THE INTERVAL STARTS AT A SUCCESSFUL READ, so a failed one can be retried
      // on the next return; one read at a time bounds the cost of retrying.
      if (readInFlight.current) return;
      if (Date.now() - lastRefreshAt.current < REFRESH_MIN_INTERVAL_MS) return;
      readInFlight.current = true;
      const began = epoch.current;
      void (async () => {
        try {
          // A hung read must not pin readInFlight forever (no further refresh
          // would ever start). On timeout the result is dropped, like a failure.
          let timer: ReturnType<typeof setTimeout> | undefined;
          const next = await Promise.race([
            loadInvitationAction(token),
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), REFRESH_TIMEOUT_MS);
            }),
          ]).finally(() => clearTimeout(timer));
          if (next === null || next.kind === "error") return;
          lastRefreshAt.current = Date.now();
          // STALE IF an action started since (new epoch), one is running, or the
          // screen is no longer an offer: a booked or declined screen must never
          // be overwritten by a read that began before it.
          if (epoch.current !== began) return;
          if (latest.current.pending || latest.current.kind !== "offer") return;
          applyState(next);
        } catch {
          // keep the current offer
        } finally {
          readInFlight.current = false;
        }
      })();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [applyState, token]);

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
      onTimesDontWork={
        timesFeedback ? (note: string) => run(() => timesDontWorkAction(token, note)) : undefined
      }
    />
  );
}
