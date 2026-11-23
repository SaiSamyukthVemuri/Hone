import { after } from "next/server";
import { safeLog } from "@/lib/logging/safe-log";

// OBSERVE-ONLY enforcement point for the Roles permission engine (the database function has_studio_permission;
// absent on local and CI stacks).
//
// It asks the database what the engine WOULD answer for the signed-in user and records the answer. It never
// decides anything: it returns nothing, so no caller can branch on it, and it never throws. Behaviour for every
// user is exactly what it was before this call existed. Turning a key into a real check is a later change with its
// own review, and activation is a separate approval.
//
// Why observe first: nothing in the app asks the engine yet. Before any key is allowed to refuse a
// person, the would-deny rate by role must be known for a real studio. A key that refuses an owner, or refuses a
// practitioner who is correctly assigned, would show up here first.
//
// The database function answers FALSE, not an error, for two mistakes a caller can make, so the call shape is
// closed and typed instead of a free (key, context) pair:
//   * an unknown key, and
//   * an `own` scope with the wrong context argument. appt.book is "own" by practitioner, appt.move is "own" by
//     appointment, appt.reassign has no own scope. A booking has no appointment yet, so it passes the TARGET
//     practitioner.
// A wrong shape would log would-deny for every correctly assigned practitioner and make the evidence noise.
// tests/db/permission-observe.db.test.ts reads those scopes from the installed engine and fails when this table
// drifts from it.
//
// It is OFF the user's path. observePermission starts the read at once and hands the promise to Next's `after()`,
// which keeps the invocation alive until it settles, so a booking or a move never waits on the engine. The promise
// goes to after() as a PROMISE, never as a callback (SENTRY-AFTER-01, lib/analytics/server.ts): a callback would
// enrol the request's own work-unit store and break a later cookies() read. Out of request scope, after() throws and
// the read simply runs unawaited. Cost: one extra PostgREST read per booking or move, and a second when a
// reassignment is requested; the function is a handful of indexed lookups.
//
// Logs carry the key, the outcome and the actor's ROLE only. No studio, appointment, client or user id: server
// logs go to a third party and must stay free of record ids (safe-log.ts).
//
// It must be handed the SIGNED-IN user's client. The function resolves the actor from auth.uid(); a service-role
// client has no such user and would answer false for every key.

export type ObservedPermission =
  | { readonly key: "appt.book"; readonly practitionerId: string }
  | { readonly key: "appt.move"; readonly appointmentId: string }
  | { readonly key: "appt.reassign" };

/** The own-scope context each observed key needs, from the engine's key catalogue. Pinned against the installed engine by the DB test. */
export const OBSERVED_KEY_CONTEXT = {
  "appt.book": "practitioner",
  "appt.move": "appointment",
  "appt.reassign": null,
} as const satisfies Record<ObservedPermission["key"], "practitioner" | "appointment" | null>;

type RpcResult = PromiseLike<{ data: unknown; error: unknown }>;
export type ObserveDb = {
  rpc: (fn: "has_studio_permission", args: Record<string, unknown>) => RpcResult;
};

export type ObserveOutcome = "would_deny" | "unreadable" | "engine_absent";

// A slow engine must never slow a booking or a move. Past this the answer is recorded as unreadable.
export const OBSERVE_TIMEOUT_MS = 1500;

// Postgres 42883 naming has_studio_permission, or PostgREST PGRST202: the function itself is missing. A present
// engine whose inner helper is missing (a partial apply) is not "absent"; it is unreadable.
export function isEngineAbsent(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  const text = typeof message === "string" ? message : "";
  if (code === "PGRST202") return true;
  if (code === "42883") return /has_studio_permission/i.test(text);
  return /could not find the function public\.has_studio_permission/i.test(text);
}

let absentLogged = false;
/** Test hook: the engine-absent notice is logged once per process. */
export function resetEngineAbsentNotice(): void {
  absentLogged = false;
}

function record(outcome: ObserveOutcome, key: string, actorRole: string): void {
  if (outcome === "engine_absent") {
    // Expected on a database without the engine (local and CI stacks). Once per process, never per request.
    if (absentLogged) return;
    absentLogged = true;
  }
  try {
    safeLog.warn(JSON.stringify({ event: "permission_observe", outcome, key, actorRole, timestamp: new Date().toISOString() }));
  } catch {
    // Observing must never change what the caller gets.
  }
}

function contextArgs(ask: ObservedPermission): { p_appointment: string | null; p_practitioner: string | null } {
  switch (ask.key) {
    case "appt.book":
      return { p_appointment: null, p_practitioner: ask.practitionerId };
    case "appt.move":
      return { p_appointment: ask.appointmentId, p_practitioner: null };
    case "appt.reassign":
      return { p_appointment: null, p_practitioner: null };
  }
}

/** Fire and forget. Returns nothing, so no caller can branch on it, and never throws. */
export function observePermission(db: ObserveDb | (() => Promise<ObserveDb>), studioId: string, actorRole: string, ask: ObservedPermission): void {
  // observePermissionNow never rejects; the catch keeps that a guarantee. The read starts now, on this tick.
  const task = observePermissionNow(db, studioId, actorRole, ask).catch(() => {});
  try {
    after(task);
  } catch {
    // Out of request scope (or after() unavailable): the read is already running, unawaited.
  }
}

/** The awaitable form, for tests and the database proof. Request handlers use observePermission. */
export async function observePermissionNow(db: ObserveDb | (() => Promise<ObserveDb>), studioId: string, actorRole: string, ask: ObservedPermission): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A thunk lets the caller build the client (a cookie read) inside the never-throws guarantee: a failure to
    // build it is recorded as unreadable like any other failure, never thrown into the caller.
    const args = { p_studio: studioId, p_key: ask.key, p_client: null, ...contextArgs(ask) };
    const call = Promise.resolve(typeof db === "function" ? db().then((client) => client.rpc("has_studio_permission", args)) : db.rpc("has_studio_permission", args));
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), OBSERVE_TIMEOUT_MS);
    });
    const raced = await Promise.race([call, timeout]);
    if (raced === "timeout") return record("unreadable", ask.key, actorRole);
    const { data, error } = raced;
    if (error) return record(isEngineAbsent(error) ? "engine_absent" : "unreadable", ask.key, actorRole);
    if (data === true) return; // The expected answer, and the common one. Silent.
    record(data === false ? "would_deny" : "unreadable", ask.key, actorRole);
  } catch (e) {
    record(isEngineAbsent(e) ? "engine_absent" : "unreadable", ask.key, actorRole);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
