"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
  availabilityKey,
  candidateKey,
  type InternalBookingCandidateIdentity,
} from "./candidate";
import {
  currentRequestToken,
  initialState,
  isLoading,
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
// A REQUEST'S LIFETIME IS THE QUESTION, NOT THE WANTING
// -----------------------------------------------------
// The first version keyed this effect on a derived `needsLoad` boolean. That
// boolean is true precisely until the request records that it started, so the
// sequence was:
//
//   needsLoad true -> effect runs -> dispatch SLOT_REQUEST_STARTED
//     -> needsLoad false -> dependency changed -> React runs the CLEANUP
//     -> the effect cancels the request it had just issued
//
// and the controller sat in "loading" forever. The lesson is not "add a timing
// guard"; it is that a request's lifetime must be keyed to the QUESTION being
// asked, which does not change when the asking begins.
//
// The key is `currentRequestToken`: the availability identity plus an explicit
// retry epoch. It changes when the candidate changes (supersede the old
// request, issue a new one) and when a retry is requested (issue exactly one
// replacement), and at no other time. Recording a start, committing a result,
// recording a failure, and every state change that is not the availability
// question all leave it alone -- so none of them can kill an in-flight load.

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
  const [state, dispatch] = useReducer(reduce, input.identity, initialState);

  // Keep the reducer's state in step with the props/state the surface owns.
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
  // The chosen length is CONTROLLER STATE, not a bare argument passed to the
  // decision at render time. It participates in the effective interval, so an
  // approval granted before it changed must stop being current -- which only
  // works if the reducer knows about it.
  useEffect(() => {
    dispatch({
      type: "CUSTOM_DURATION_CHANGED",
      minutes: input.customDurationMinutes,
    });
  }, [input.customDurationMinutes]);

  // The live state, readable from inside an async continuation.
  const stateRef = useRef(state);
  stateRef.current = state;
  const loadRef = useRef(input.load);
  loadRef.current = input.load;
  const onErrRef = useRef(input.onLoadError);
  onErrRef.current = input.onLoadError;

  const token = currentRequestToken(state);

  useEffect(() => {
    // Null means the candidate is too incomplete to ask anything.
    if (token === null) return;
    // Read through the REF, never as a dependency. As a dependency this is the
    // self-cancelling load described above; as a ref read it simply means
    // "this exact question has already been asked", which is what stops a
    // return trip to an earlier candidate from refetching an answer still held.
    if (!needsLoad(stateRef.current)) return;
    const requested = stateRef.current.identity;
    dispatch({ type: "SLOT_REQUEST_STARTED", token });
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
        dispatch({ type: "SLOT_REQUEST_FAILED", token });
        return;
      }
      // Every dispatch carries the token it answers for; the reducer refuses
      // any whose token has moved on. Cancellation is a courtesy, not the guard.
      dispatch({
        type: "SLOT_REQUEST_SUCCEEDED",
        token,
        // Stamped with the question this request was issued for, taken from the
        // identity the loader was actually handed.
        snapshot: { ...r.snapshot, availabilityKey: availabilityKey(requested) },
      });
    })();
    return () => {
      cancelled = true;
    };
    // DELIBERATELY the token alone. Adding any state-derived value here
    // reintroduces the self-cancelling load this comment block describes.
  }, [token]);

  const decision: InternalBookingDecision = useMemo(
    () => decide({ state, isOwner: input.isOwner }),
    [state, input.isOwner],
  );

  const send = useCallback((e: InternalBookingEvent) => dispatch(e), []);
  // The ONLY route out of a failed load that does not require the practitioner
  // to change or reopen the candidate.
  const retry = useCallback(() => dispatch({ type: "RETRY_REQUESTED" }), []);

  return {
    state,
    decision,
    send,
    retry,
    /** The identity string a buffer refusal must be scoped to. */
    candidateKey: candidateKey(state.identity),
    slots: decision.snapshotStale ? [] : (state.snapshot?.slots ?? []),
    loading: isLoading(state),
    loadFailed: state.loadFailed,
  };
}

export type InternalBookingController = ReturnType<
  typeof useInternalBookingController
>;
export type { InternalBookingState, InternalBookingDecision };
