"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { utcInstantFromLocal } from "../tz";
import {
  availabilityKey,
  candidateKey,
  type InternalBookingCandidateIdentity,
} from "./candidate";
import {
  currentAvailabilityKey,
  initialState,
  needsLoad,
  reduce,
  type InternalBookingEvent,
  type InternalBookingState,
} from "./reducer";
import { decide, type InternalBookingDecision } from "./decisions";
import type { InternalBookingServerSnapshot } from "./server-snapshot";

// THE ONE ADAPTER SEAM.
//
// Both internal booking surfaces mount this. They render differently; they do
// not think differently. Everything that decides what a candidate MEANS -- its
// identity, when a result may commit, what is revoked by a change, whether the
// practitioner may confirm, and what gets submitted -- lives in the reducer and
// the decision function underneath, not in either component.
//
// Recovery is DERIVED here, not remembered: the effect below watches the
// current availability key, so ANY identity change (including a dimension added
// to the type later) triggers the replacement load. The previous hand-written
// effect watched two named props and missed a third.

export type LoadResult =
  | { ok: true; snapshot: Omit<InternalBookingServerSnapshot, "availabilityKey"> }
  | { ok: false; error: string };

export function useInternalBookingController(input: {
  identity: InternalBookingCandidateIdentity;
  isOwner: boolean;
  customDurationMinutes: number | null;
  /** Issues the availability request for exactly the identity it is handed. */
  load: (identity: InternalBookingCandidateIdentity) => Promise<LoadResult>;
  onLoadError?: (error: string) => void;
}) {
  const [state, dispatch] = useReducer(
    reduce,
    input.identity,
    initialState,
  );

  // Keep the reducer's identity in step with the props/state the surface owns.
  // Each dimension is its own event so the transition law -- not the caller --
  // decides what a change revokes.
  const id = input.identity;
  useEffect(() => {
    dispatch({ type: "CLIENT_CHANGED", clientId: id.clientId });
  }, [id.clientId]);
  useEffect(() => {
    dispatch({ type: "SERVICE_CHANGED", serviceId: id.serviceId });
  }, [id.serviceId]);
  useEffect(() => {
    dispatch({ type: "DATE_CHANGED", date: id.date });
  }, [id.date]);
  useEffect(() => {
    dispatch({
      type: "TARGET_CHANGED",
      targetPractitionerId: id.targetPractitionerId,
    });
  }, [id.targetPractitionerId]);
  useEffect(() => {
    dispatch({ type: "CAPACITY_MODE_CHANGED", capacityMode: id.capacityMode });
  }, [id.capacityMode]);
  useEffect(() => {
    dispatch({ type: "TIMEZONE_CHANGED", timezone: id.timezone });
  }, [id.timezone]);

  // The live state, readable from inside an async continuation.
  const stateRef = useRef(state);
  stateRef.current = state;
  const loadRef = useRef(input.load);
  loadRef.current = input.load;
  const onErrRef = useRef(input.onLoadError);
  onErrRef.current = input.onLoadError;

  const key = currentAvailabilityKey(state);
  const wants = needsLoad(state);

  useEffect(() => {
    if (!wants) return;
    const requested = stateRef.current.identity;
    const requestedKey = availabilityKey(requested);
    dispatch({ type: "SLOT_REQUEST_STARTED", key: requestedKey });
    let cancelled = false;
    void (async () => {
      let r: LoadResult;
      try {
        r = await loadRef.current(requested);
      } catch {
        r = { ok: false, error: "Could not load times. Please try again." };
      }
      if (cancelled) return;
      if (!r.ok) {
        onErrRef.current?.(r.error);
        dispatch({ type: "SLOT_REQUEST_FAILED", key: requestedKey });
        return;
      }
      // The snapshot carries the key it answers for; the reducer refuses it if
      // the candidate has moved on. Cancellation is a courtesy, not the guard.
      dispatch({
        type: "SLOT_REQUEST_SUCCEEDED",
        snapshot: { ...r.snapshot, availabilityKey: requestedKey },
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [wants, key]);

  const decision: InternalBookingDecision = useMemo(
    () =>
      decide({
        state,
        isOwner: input.isOwner,
        customDurationMinutes: input.customDurationMinutes,
        toInstantIso: (d, t) => {
          const at = utcInstantFromLocal(d, t, state.identity.timezone);
          return Number.isNaN(at.getTime()) ? null : at.toISOString();
        },
      }),
    [state, input.isOwner, input.customDurationMinutes],
  );

  const send = useCallback((e: InternalBookingEvent) => dispatch(e), []);

  return {
    state,
    decision,
    send,
    /** The identity string a buffer refusal must be scoped to. */
    candidateKey: candidateKey(state.identity),
    slots: decision.snapshotStale ? [] : (state.snapshot?.slots ?? []),
    loading: state.loadingKey !== null,
  };
}

export type InternalBookingController = ReturnType<
  typeof useInternalBookingController
>;
export type { InternalBookingState, InternalBookingDecision };
