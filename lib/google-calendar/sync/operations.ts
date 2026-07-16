import "server-only";
import { deriveEventId, verifyEventMarker } from "./event-id";
import type { GoogleError } from "./errors";
import type { GoogleEventResource, GoogleRestClient } from "./google-rest-client";
import type { SyncOperationContext, SyncOperations } from "./handler";
import type { JobResult } from "./job-result";
import {
  OpsStoreError,
  type AppointmentState,
  type LinkRow,
  type OpsLinkStore,
  type TransitionResult,
} from "./link-transition-store";
import { buildAppointmentEventPayload } from "./serializer";
import { evaluateStaleFence, jobSyncVersion } from "./stale-fence";

// Google Calendar — Phase B2.3-c1: the real event operations (create / update /
// delete) plus provider reconciliation. DORMANT: imported only by server-only
// worker modules; no app route wires it and the worker/flags are OFF.
//
// Invariants enforced here:
//  * Every LINK write goes through the transactional calendar_event_link_transition
//    RPC (which itself re-binds the claimed outbox row + fences the appointment
//    version); the outbox row stays under claim -> handle ->
//    record_calendar_sync_result. This layer never transitions the outbox.
//  * Before EVERY provider call — and again before every FOLLOW-UP provider call
//    on a recovery path — the operation re-reads the appointment + link, re-runs
//    the stale fence, and re-checks job/link/connection/calendar alignment.
//  * A 2xx provider body is never trusted for persistence until its id, status,
//    private marker and ETag are validated (or reconciled via GET).
//  * A DB read failure is retry_transient, never a success no-op.
//  * A cancelled Google event is never bound as `synced`; a fresh lifecycle only
//    comes from a fresh link row (rotate_for_recreate).

export type OperationDeps = {
  rest: GoogleRestClient;
  store: OpsLinkStore;
  // REQUIRED. Invalidate the per-connection cached access token (called on a
  // Google 401 so the next attempt refreshes rather than reusing the rejected
  // token). Making this mandatory means the future B2.3-c2 worker route CANNOT
  // wire the live operations map without cache invalidation (compile-time gate).
  // Never logs a token.
  invalidateAccessToken: (connectionId: string) => void | Promise<void>;
};

function extractPrivate(event: GoogleEventResource): Record<string, unknown> | null {
  const ext = (event as Record<string, unknown>).extendedProperties;
  if (!ext || typeof ext !== "object") return null;
  const priv = (ext as Record<string, unknown>).private;
  return priv && typeof priv === "object" ? (priv as Record<string, unknown>) : null;
}
function icalUidOf(event: GoogleEventResource): string | null {
  const v = (event as Record<string, unknown>).iCalUID;
  return typeof v === "string" ? v : null;
}
function isNetwork(err: GoogleError): boolean {
  return err.kind === "transient" && (err.code === "network_timeout" || err.code === "network_error");
}

// Map a Google error the caller does not special-case. A 401 invalidates the
// cached access token first so the next attempt refreshes.
async function handleGoogleError(ctx: SyncOperationContext, deps: OperationDeps, err: GoogleError): Promise<JobResult> {
  switch (err.kind) {
    case "token_expired":
      try {
        await deps.invalidateAccessToken(ctx.job.connectionId);
      } catch {
        /* invalidation is best-effort; never surfaces a token */
      }
      return { code: "retry_transient", errorCode: err.code };
    case "insufficient_scope":
      return { code: "terminal_insufficient_scope", errorCode: err.code };
    case "rate_limited":
      return { code: "retry_rate_limited", errorCode: err.code, retryAfterSeconds: err.retryAfterSeconds ?? undefined };
    case "permanent_error":
      // An unrecoverable request error (e.g. 400/405) — do not consume all retry
      // attempts as an unknown transient.
      return { code: "terminal_conflict", errorCode: err.code };
    case "config_error":
      return { code: "retry_ineligible", errorCode: err.code };
    default:
      return { code: "retry_transient", errorCode: err.code };
  }
}

// A follow-up mutation that reuses a GET's ETag as its If-Match MUST have a
// non-empty ETag — never silently omit If-Match. Returns the ETag or null.
function freshEtag(etag: string | null): string | null {
  return typeof etag === "string" && etag.length > 0 ? etag : null;
}

// Map a link-transition rejection. ONLY genuine supersession / lost-claim states
// become a success no-op; tenant/link/binding/integrity mismatches are terminal
// conflicts; an infra error is retryable.
function mapTransitionReject(t: TransitionResult): JobResult {
  switch (t.code) {
    // Integrity conflicts — never a success.
    case "moved_link_conflict":
    case "foreign_event_conflict":
    case "already_bound_other":
    case "link_mismatch":
    case "outbox_studio_mismatch":
    case "outbox_connection_mismatch":
    case "outbox_entity_mismatch":
    case "outbox_link_mismatch":
    case "action_op_mismatch":
    case "version_arg_missing":
    case "version_arg_mismatch":
    case "missing_provider_id":
    case "missing_provider_etag": // app-contract backstop — unreachable once §2/§3 land; operator-visible if reached
    case "link_is_placeholder":
    case "provider_id_mismatch":
    case "entity_unsupported":
      return { code: "terminal_conflict", errorCode: t.code };
    // Genuine supersession / lost claim — a truthful terminal-success no-op.
    case "stale_token":
    case "outbox_not_processing":
    case "stale_version":
    case "link_deleted":
    case "superseded":
    case "appointment_superseded":
    case "appointment_gone":
    case "appointment_not_confirmed":
      return { code: "ok_noop_superseded", errorCode: t.code };
    case "link_not_found":
      return { code: "ok_noop_no_active_link", errorCode: t.code };
    // Temporary destination/connection transition.
    case "connection_not_ready":
      return { code: "retry_ineligible", errorCode: t.code };
    // Infra / RPC error.
    case "rpc_error":
      return { code: "retry_transient", errorCode: t.code };
    default:
      return { code: "retry_transient", errorCode: `transition_${t.code}` };
  }
}

// Job/link/connection/calendar alignment (§5). An identity mismatch is a terminal
// integrity conflict; a calendar mismatch is a temporary destination transition.
function checkAlignment(ctx: SyncOperationContext, link: LinkRow): JobResult | null {
  if (
    link.studioId !== ctx.job.studioId ||
    link.connectionId !== ctx.job.connectionId ||
    link.honeEntityType !== ctx.job.honeEntityType ||
    link.honeEntityId !== ctx.job.honeEntityId
  ) {
    return { code: "terminal_conflict", errorCode: "link_job_mismatch" };
  }
  // Calendar alignment: a missing/empty current write calendar, or one that differs
  // from the link's calendar, must NOT dispatch. Only an exact non-empty match proceeds.
  const writeCal = ctx.connection.writeCalendarId;
  if (!writeCal || writeCal.length === 0 || link.googleCalendarId !== writeCal) {
    return { code: "retry_ineligible", errorCode: "calendar_alignment" };
  }
  return null;
}

type FenceOutcome =
  | { stop: JobResult }
  | { ok: true; appointment: AppointmentState; link: LinkRow; mode: "create" | "update" | "delete" };

// Reload the appointment + active link, re-run the stale fence, and re-check
// alignment. The single re-fence used before every (follow-up) provider call.
async function refence(ctx: SyncOperationContext, deps: OperationDeps): Promise<FenceOutcome> {
  const entityId = ctx.job.honeEntityId;
  const entityType = ctx.job.honeEntityType;
  const appointment = entityId ? await deps.store.loadAppointmentState(entityId, ctx.job.studioId) : null;
  const link = entityType && entityId ? await deps.store.loadActiveLinkByEntity(ctx.job.studioId, entityType, entityId) : null;
  const fence = evaluateStaleFence({ job: ctx.job, appointment, link });
  if (fence.kind === "noop") return { stop: { code: fence.code } };
  if (fence.kind === "conflict") return { stop: { code: "terminal_conflict", errorCode: "entity_link_mismatch" } };
  if (!link || !appointment) return { stop: { code: "ok_noop_no_active_link" } };
  const align = checkAlignment(ctx, link);
  if (align) return { stop: align };
  return { ok: true, appointment, link, mode: fence.mode };
}

function payloadFor(appointment: AppointmentState, linkId: string): { ok: true; payload: Record<string, unknown> } | { stop: JobResult } {
  const ser = buildAppointmentEventPayload({
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
    studioTimezone: appointment.studioTimezone,
    linkId,
  });
  if (!ser.ok) return { stop: { code: "terminal_conflict", errorCode: `serialize_${ser.reason}` } };
  return { ok: true, payload: ser.payload };
}

// Validate a 2xx provider event before ANY persistence (§7).
type RespVerdict = "ok" | "cancelled_ours" | "conflict" | "needs_get";
function validateEventResponse(event: GoogleEventResource, etag: string | null, expectedId: string, linkId: string): RespVerdict {
  if (!event || typeof event !== "object" || typeof event.id !== "string") return "needs_get";
  if (event.id !== expectedId) return "conflict";
  const marker = verifyEventMarker(extractPrivate(event), linkId);
  if (event.status === "cancelled") return marker === "match" ? "cancelled_ours" : "conflict";
  if (marker === "mismatch") return "conflict";
  if (marker === "absent") return "needs_get";
  if (typeof etag !== "string" || etag.length === 0) return "needs_get";
  return "ok";
}

async function bindConfirmedRpc(
  ctx: SyncOperationContext,
  deps: OperationDeps,
  link: LinkRow,
  providerId: string,
  event: GoogleEventResource,
  etag: string | null,
): Promise<JobResult> {
  const t = await deps.store.transition({
    action: "bind_confirmed",
    outboxId: ctx.job.id,
    claimToken: ctx.job.claimToken,
    linkId: link.id,
    studioId: link.studioId,
    connectionId: link.connectionId,
    honeEntityType: link.honeEntityType,
    honeEntityId: link.honeEntityId,
    expectedSourceVersion: jobSyncVersion(ctx.job),
    googleEventId: providerId,
    googleIcalUid: icalUidOf(event),
    googleEtag: etag,
  });
  if (t.status === "ok") return { code: "ok" };
  // The link is already bound to the SAME id at an older version: reload + update.
  if (t.code === "bound_older_version") return realUpdateFlow(ctx, deps);
  return mapTransitionReject(t);
}

// Validate a 2xx response then bind (or reconcile via GET / rotate).
async function bindFromResponse(
  ctx: SyncOperationContext,
  deps: OperationDeps,
  link: LinkRow,
  expectedId: string,
  event: GoogleEventResource,
  etag: string | null,
): Promise<JobResult> {
  const v = validateEventResponse(event, etag, expectedId, link.id);
  if (v === "ok") return bindConfirmedRpc(ctx, deps, link, expectedId, event, etag);
  if (v === "cancelled_ours") return rotateAndCreate(ctx, deps, link);
  if (v === "conflict") return { code: "terminal_conflict", errorCode: "response_invalid" };
  // needs_get — reconcile by GET before trusting anything.
  const got = await deps.rest.getEvent({ accessToken: ctx.accessToken, calendarId: link.googleCalendarId, eventId: expectedId });
  if (got.ok) {
    const v2 = validateEventResponse(got.event, got.etag, expectedId, link.id);
    if (v2 === "ok") return bindConfirmedRpc(ctx, deps, link, expectedId, got.event, got.etag);
    if (v2 === "cancelled_ours") return rotateAndCreate(ctx, deps, link);
    if (v2 === "conflict") return { code: "terminal_conflict", errorCode: "get_invalid" };
    return { code: "retry_transient", errorCode: "get_unverified" };
  }
  if (got.error.kind === "not_found") return { code: "retry_transient", errorCode: "post_success_absent" };
  return handleGoogleError(ctx, deps, got.error);
}

// Insert a fresh event for the current active link, then validate + bind.
async function insertFlow(ctx: SyncOperationContext, deps: OperationDeps): Promise<JobResult> {
  const f = await refence(ctx, deps); // re-fence immediately before INSERT (§6)
  if ("stop" in f) return f.stop;
  if (f.mode === "update") return realUpdate(ctx, deps, f.appointment, f.link);
  if (f.mode !== "create") return { code: "ok_noop_superseded" };
  const eventId = deriveEventId(f.link.studioId, f.link.id);
  const pay = payloadFor(f.appointment, f.link.id);
  if ("stop" in pay) return pay.stop;
  const res = await deps.rest.insertEvent({ accessToken: ctx.accessToken, calendarId: f.link.googleCalendarId, event: { id: eventId, ...pay.payload } });
  if (res.ok) return bindFromResponse(ctx, deps, f.link, eventId, res.event, res.etag);
  const err = res.error;
  if (err.kind === "conflict") return reconcileByGet(ctx, deps, f.link, f.appointment, eventId); // 409 duplicate
  if (isNetwork(err)) return reconcileByGet(ctx, deps, f.link, f.appointment, eventId); // ambiguous
  return handleGoogleError(ctx, deps, err);
}

// GET the derived id and reconcile (409 / ambiguous / retry). Adoption of a live
// matching event goes through a PATCH-then-bind (adoptViaPatch), never bind-as-found.
async function reconcileByGet(
  ctx: SyncOperationContext,
  deps: OperationDeps,
  link: LinkRow,
  appointment: AppointmentState,
  eventId: string,
): Promise<JobResult> {
  const got = await deps.rest.getEvent({ accessToken: ctx.accessToken, calendarId: link.googleCalendarId, eventId });
  if (got.ok) {
    const marker = verifyEventMarker(extractPrivate(got.event), link.id);
    if (marker !== "match") return { code: "terminal_conflict", errorCode: "foreign_event" };
    if (got.event.status === "cancelled") return rotateAndCreate(ctx, deps, link);
    return adoptViaPatch(ctx, deps, link, eventId, got.etag);
  }
  if (got.error.kind === "not_found") return { code: "retry_transient", errorCode: "conflict_then_absent" };
  return handleGoogleError(ctx, deps, got.error);
}

// Adopt an existing matching provider event by PATCHing the CURRENT v1 payload
// (never bind as-found), then bind at the job version (addendum §2).
async function adoptViaPatch(ctx: SyncOperationContext, deps: OperationDeps, link: LinkRow, eventId: string, getEtag: string | null): Promise<JobResult> {
  const etag = freshEtag(getEtag);
  if (!etag) return { code: "retry_transient", errorCode: "adopt_get_no_etag" }; // never PATCH without If-Match
  const f = await refence(ctx, deps);
  if ("stop" in f) return f.stop;
  if (f.link.id !== link.id) return dispatchMode(ctx, deps, f); // state moved (rotation) — re-dispatch
  const pay = payloadFor(f.appointment, f.link.id);
  if ("stop" in pay) return pay.stop;
  const res = await deps.rest.patchEvent({ accessToken: ctx.accessToken, calendarId: f.link.googleCalendarId, eventId, event: pay.payload, etag });
  if (res.ok) return bindFromResponse(ctx, deps, f.link, eventId, res.event, res.etag);
  if (res.error.kind === "precondition_failed") return patch412(ctx, deps, f.link, eventId, /*bind*/ true);
  if (res.error.kind === "not_found") return insertFlow(ctx, deps); // vanished between GET and PATCH
  return handleGoogleError(ctx, deps, res.error);
}

async function rotateAndCreate(ctx: SyncOperationContext, deps: OperationDeps, link: LinkRow): Promise<JobResult> {
  const t = await deps.store.transition({
    action: "rotate_for_recreate",
    outboxId: ctx.job.id,
    claimToken: ctx.job.claimToken,
    linkId: link.id,
    studioId: link.studioId,
    connectionId: link.connectionId,
    honeEntityType: link.honeEntityType,
    honeEntityId: link.honeEntityId,
    expectedSourceVersion: jobSyncVersion(ctx.job),
  });
  if (t.status !== "ok" || !t.linkId) return mapTransitionReject(t);
  // Reload the replacement, re-fence, and create on it (§6 after rotation).
  const fresh = await deps.store.loadLinkById(t.linkId);
  if (!fresh) return { code: "retry_transient", errorCode: "rotate_reload_missing" };
  return insertFlow(ctx, deps);
}

// Real update against a bound link (patch If-Match). 404/410/cancelled -> rotate;
// 412 -> re-GET + marker verify + re-fence + reapply.
async function realUpdate(ctx: SyncOperationContext, deps: OperationDeps, appointment: AppointmentState, link: LinkRow): Promise<JobResult> {
  const providerId = link.googleEventId as string;
  const pay = payloadFor(appointment, link.id);
  if ("stop" in pay) return pay.stop;
  const res = await deps.rest.patchEvent({ accessToken: ctx.accessToken, calendarId: link.googleCalendarId, eventId: providerId, event: pay.payload, etag: link.googleEtag });
  if (res.ok) {
    if (res.event.status === "cancelled") return rotateAndCreate(ctx, deps, link);
    return updateFromResponse(ctx, deps, link, providerId, res.event, res.etag);
  }
  const err = res.error;
  if (err.kind === "not_found") return rotateAndCreate(ctx, deps, link);
  if (err.kind === "precondition_failed") return patch412(ctx, deps, link, providerId, /*bind*/ false);
  if (err.kind === "conflict") return { code: "terminal_conflict", errorCode: "update_conflict" };
  return handleGoogleError(ctx, deps, err);
}

// Re-dispatch to the correct flow after a re-fence (create/update).
async function realUpdateFlow(ctx: SyncOperationContext, deps: OperationDeps): Promise<JobResult> {
  const f = await refence(ctx, deps);
  if ("stop" in f) return f.stop;
  return dispatchMode(ctx, deps, f);
}
async function dispatchMode(ctx: SyncOperationContext, deps: OperationDeps, f: Extract<FenceOutcome, { ok: true }>): Promise<JobResult> {
  if (f.mode === "create") return insertFlow(ctx, deps);
  if (f.mode === "update") return realUpdate(ctx, deps, f.appointment, f.link);
  return { code: "ok_noop_superseded" };
}

// 412 recovery for PATCH: GET, verify OUR marker, re-fence, reapply with the fresh
// etag. `bind` = true when the follow-up should PATCH-then-bind (adopt/create-and-
// bind); false for a plain real update.
async function patch412(ctx: SyncOperationContext, deps: OperationDeps, link: LinkRow, eventId: string, bind: boolean): Promise<JobResult> {
  const got = await deps.rest.getEvent({ accessToken: ctx.accessToken, calendarId: link.googleCalendarId, eventId });
  if (!got.ok) {
    if (got.error.kind === "not_found") return rotateAndCreate(ctx, deps, link);
    return handleGoogleError(ctx, deps, got.error);
  }
  const marker = verifyEventMarker(extractPrivate(got.event), link.id);
  if (marker !== "match") return { code: "terminal_conflict", errorCode: "foreign_on_412_patch" };
  if (got.event.status === "cancelled") return rotateAndCreate(ctx, deps, link);
  const etag = freshEtag(got.etag);
  if (!etag) return { code: "retry_transient", errorCode: "patch412_get_no_etag" }; // never reapply without If-Match
  const f = await refence(ctx, deps); // reload Hone state before reapplying
  if ("stop" in f) return f.stop;
  if (f.link.id !== link.id) return dispatchMode(ctx, deps, f);
  const pay = payloadFor(f.appointment, f.link.id);
  if ("stop" in pay) return pay.stop;
  const res2 = await deps.rest.patchEvent({ accessToken: ctx.accessToken, calendarId: f.link.googleCalendarId, eventId, event: pay.payload, etag });
  if (res2.ok) {
    if (res2.event.status === "cancelled") return rotateAndCreate(ctx, deps, f.link);
    return bind ? bindFromResponse(ctx, deps, f.link, eventId, res2.event, res2.etag) : updateFromResponse(ctx, deps, f.link, eventId, res2.event, res2.etag);
  }
  if (res2.error.kind === "not_found") return rotateAndCreate(ctx, deps, f.link);
  return handleGoogleError(ctx, deps, res2.error);
}

// Persist an update ONLY from a fully-validated event (id/status/marker/etag).
async function updateConfirmedRpc(ctx: SyncOperationContext, deps: OperationDeps, link: LinkRow, providerId: string, event: GoogleEventResource, etag: string): Promise<JobResult> {
  const t = await deps.store.transition({
    action: "update_confirmed",
    outboxId: ctx.job.id,
    claimToken: ctx.job.claimToken,
    linkId: link.id,
    studioId: link.studioId,
    connectionId: link.connectionId,
    honeEntityType: link.honeEntityType,
    honeEntityId: link.honeEntityId,
    expectedSourceVersion: jobSyncVersion(ctx.job),
    googleEventId: providerId,
    googleIcalUid: icalUidOf(event),
    googleEtag: etag,
  });
  if (t.status === "ok") return { code: "ok" };
  return mapTransitionReject(t);
}

// Validate a PATCH 2xx before persisting (§2/§7). On `needs_get`, GET the exact
// provider id, re-validate, reload Hone state, re-fence, confirm the same
// lifecycle, and only then persist with the GET's ETag — NEVER the old stored
// ETag. `update_confirmed` is never called from an unverified response.
async function updateFromResponse(ctx: SyncOperationContext, deps: OperationDeps, link: LinkRow, providerId: string, event: GoogleEventResource, etag: string | null): Promise<JobResult> {
  const v = validateEventResponse(event, etag, providerId, link.id);
  if (v === "ok") return updateConfirmedRpc(ctx, deps, link, providerId, event, etag as string);
  if (v === "cancelled_ours") return rotateAndCreate(ctx, deps, link);
  if (v === "conflict") return { code: "terminal_conflict", errorCode: "update_response_invalid" };
  // needs_get — reconcile by GET before trusting anything.
  const got = await deps.rest.getEvent({ accessToken: ctx.accessToken, calendarId: link.googleCalendarId, eventId: providerId });
  if (!got.ok) {
    if (got.error.kind === "not_found") return rotateAndCreate(ctx, deps, link); // missing while confirmed -> recreate
    return handleGoogleError(ctx, deps, got.error);
  }
  const v2 = validateEventResponse(got.event, got.etag, providerId, link.id);
  if (v2 === "cancelled_ours") return rotateAndCreate(ctx, deps, link);
  if (v2 === "conflict") return { code: "terminal_conflict", errorCode: "update_get_invalid" };
  if (v2 !== "ok") return { code: "retry_transient", errorCode: "update_get_unverified" };
  // Reload Hone state, re-fence, and confirm the SAME lifecycle + provider event.
  const f = await refence(ctx, deps);
  if ("stop" in f) return f.stop;
  if (f.link.id !== link.id || f.link.googleEventId !== providerId) return dispatchMode(ctx, deps, f);
  return updateConfirmedRpc(ctx, deps, f.link, providerId, got.event, got.etag as string);
}

async function finalizeDelete(ctx: SyncOperationContext, deps: OperationDeps, link: LinkRow): Promise<JobResult> {
  const t = await deps.store.transition({
    action: "mark_deleted",
    outboxId: ctx.job.id,
    claimToken: ctx.job.claimToken,
    linkId: link.id,
    studioId: link.studioId,
    connectionId: link.connectionId,
    honeEntityType: link.honeEntityType,
    honeEntityId: link.honeEntityId,
  });
  if (t.status === "ok") return { code: "ok_noop_tombstone_deleted" };
  if (t.code === "stale_token" || t.code === "outbox_not_processing") return { code: "ok_noop_superseded", errorCode: t.code };
  return mapTransitionReject(t);
}

async function realDelete(ctx: SyncOperationContext, deps: OperationDeps, link: LinkRow): Promise<JobResult> {
  const providerId = link.googleEventId as string;
  const res = await deps.rest.deleteEvent({ accessToken: ctx.accessToken, calendarId: link.googleCalendarId, eventId: providerId, etag: link.googleEtag });
  if (res.ok) return finalizeDelete(ctx, deps, link);
  const err = res.error;
  if (err.kind === "not_found") return finalizeDelete(ctx, deps, link);
  if (err.kind === "precondition_failed") return delete412(ctx, deps, link, providerId);
  return handleGoogleError(ctx, deps, err);
}

type DeleteFence = { stop: JobResult } | { ok: true; link: LinkRow };

// Re-fence a DELETE follow-up mutation (§4). Reloads the current appointment/link,
// re-runs the delete stale fence + alignment, and confirms the SAME lifecycle
// (same link id, and for a real delete the same provider event id / for a
// placeholder still unbound). Any state change -> stop with the correct no-op /
// conflict / ineligible result (no second provider mutation).
async function refenceForDelete(ctx: SyncOperationContext, deps: OperationDeps, prior: LinkRow, mode: "real" | "placeholder"): Promise<DeleteFence> {
  let link: LinkRow | null;
  if (ctx.job.honeEntityId && ctx.job.honeEntityType) {
    const appointment = await deps.store.loadAppointmentState(ctx.job.honeEntityId, ctx.job.studioId);
    link = await deps.store.loadActiveLinkByEntity(ctx.job.studioId, ctx.job.honeEntityType, ctx.job.honeEntityId);
    const fence = evaluateStaleFence({ job: ctx.job, appointment, link });
    if (fence.kind === "noop") return { stop: { code: fence.code } };
    if (fence.kind === "conflict") return { stop: { code: "terminal_conflict", errorCode: "delete_refence_mismatch" } };
    if (!link) return { stop: { code: "ok_noop_no_active_link" } };
    const align = checkAlignment(ctx, link);
    if (align) return { stop: align };
  } else {
    link = await deps.store.loadLinkForJob(prior.id, ctx.job.studioId, ctx.job.connectionId);
    if (!link) return { stop: { code: "terminal_conflict", errorCode: "orphan_link_not_owned" } };
    if (link.deletedAt) return { stop: { code: "ok_noop_tombstone_deleted" } };
    const wc = ctx.connection.writeCalendarId;
    if (!wc || wc.length === 0 || link.googleCalendarId !== wc) return { stop: { code: "retry_ineligible", errorCode: "calendar_alignment" } };
  }
  if (link.id !== prior.id) return { stop: { code: "ok_noop_superseded", errorCode: "link_moved" } };
  if (mode === "real" && link.googleEventId !== prior.googleEventId) return { stop: { code: "ok_noop_superseded", errorCode: "provider_moved" } };
  if (mode === "placeholder" && link.googleEventId !== null) return { stop: { code: "ok_noop_superseded", errorCode: "placeholder_bound" } };
  return { ok: true, link };
}

// 412 recovery for DELETE: GET, verify OUR marker + a non-empty ETag, re-fence,
// then re-delete with the fresh ETag.
async function delete412(ctx: SyncOperationContext, deps: OperationDeps, link: LinkRow, providerId: string): Promise<JobResult> {
  const got = await deps.rest.getEvent({ accessToken: ctx.accessToken, calendarId: link.googleCalendarId, eventId: providerId });
  if (!got.ok) {
    if (got.error.kind === "not_found") return finalizeDelete(ctx, deps, link);
    return handleGoogleError(ctx, deps, got.error);
  }
  const marker = verifyEventMarker(extractPrivate(got.event), link.id);
  if (marker !== "match") return { code: "terminal_conflict", errorCode: "foreign_on_412_delete" };
  if (got.event.status === "cancelled") return finalizeDelete(ctx, deps, link);
  const etag = freshEtag(got.etag);
  if (!etag) return { code: "retry_transient", errorCode: "delete412_get_no_etag" }; // never delete without If-Match
  const f = await refenceForDelete(ctx, deps, link, "real");
  if ("stop" in f) return f.stop;
  const res2 = await deps.rest.deleteEvent({ accessToken: ctx.accessToken, calendarId: f.link.googleCalendarId, eventId: providerId, etag });
  if (res2.ok || res2.error.kind === "not_found") return finalizeDelete(ctx, deps, f.link);
  return handleGoogleError(ctx, deps, res2.error);
}

// GET-verified placeholder orphan delete — NEVER a blind DELETE against a derived
// id; requires a non-empty ETag and a re-fence before the DELETE.
async function placeholderDelete(ctx: SyncOperationContext, deps: OperationDeps, link: LinkRow): Promise<JobResult> {
  const eventId = deriveEventId(link.studioId, link.id);
  const got = await deps.rest.getEvent({ accessToken: ctx.accessToken, calendarId: link.googleCalendarId, eventId });
  if (got.ok) {
    const marker = verifyEventMarker(extractPrivate(got.event), link.id);
    if (marker !== "match") return { code: "terminal_conflict", errorCode: "placeholder_foreign" };
    if (got.event.status === "cancelled") return finalizeDelete(ctx, deps, link);
    const etag = freshEtag(got.etag);
    if (!etag) return { code: "retry_transient", errorCode: "placeholder_get_no_etag" }; // never delete without If-Match
    const f = await refenceForDelete(ctx, deps, link, "placeholder");
    if ("stop" in f) return f.stop;
    const res = await deps.rest.deleteEvent({ accessToken: ctx.accessToken, calendarId: f.link.googleCalendarId, eventId, etag });
    if (res.ok || res.error.kind === "not_found") return finalizeDelete(ctx, deps, f.link);
    return handleGoogleError(ctx, deps, res.error);
  }
  if (got.error.kind === "not_found") return finalizeDelete(ctx, deps, link);
  return handleGoogleError(ctx, deps, got.error);
}

// event.create AND placeholder event.update share the upsert contract.
async function handleUpsert(ctx: SyncOperationContext, deps: OperationDeps): Promise<JobResult> {
  if (ctx.job.honeEntityType === "timed_block") return { code: "retry_ineligible", errorCode: "operation_not_implemented" };
  try {
    const f = await refence(ctx, deps);
    if ("stop" in f) return f.stop;
    return await dispatchMode(ctx, deps, f);
  } catch (e) {
    if (e instanceof OpsStoreError) return { code: "retry_transient", errorCode: "db_read_failed" };
    throw e;
  }
}

async function handleDelete(ctx: SyncOperationContext, deps: OperationDeps): Promise<JobResult> {
  if (ctx.job.honeEntityType === "timed_block") return { code: "retry_ineligible", errorCode: "operation_not_implemented" };
  try {
    const payload = ctx.job.payload ?? {};
    const linkIdFromPayload = typeof payload["hone_link_id"] === "string" ? (payload["hone_link_id"] as string) : null;

    // Entity-carrying delete (appointment cancel or hard-delete).
    if (ctx.job.honeEntityId && ctx.job.honeEntityType) {
      let link = await deps.store.loadActiveLinkByEntity(ctx.job.studioId, ctx.job.honeEntityType, ctx.job.honeEntityId);
      if (!link && linkIdFromPayload) link = await deps.store.loadLinkForJob(linkIdFromPayload, ctx.job.studioId, ctx.job.connectionId);
      const appointment = await deps.store.loadAppointmentState(ctx.job.honeEntityId, ctx.job.studioId);
      const fence = evaluateStaleFence({ job: ctx.job, appointment, link });
      if (fence.kind === "noop") return { code: fence.code };
      if (fence.kind === "conflict") return { code: "terminal_conflict", errorCode: "delete_entity_mismatch" };
      if (!link) return { code: "ok_noop_no_active_link" };
      const align = checkAlignment(ctx, link);
      if (align) return align;
      if (link.deletedAt) return { code: "ok_noop_tombstone_deleted" };
      return await (link.googleEventId ? realDelete(ctx, deps, link) : placeholderDelete(ctx, deps, link));
    }

    // Entity-less orphan/tombstone delete — SCOPED to the job's studio + connection.
    if (!linkIdFromPayload) return { code: "ok_noop_no_active_link" };
    const link = await deps.store.loadLinkForJob(linkIdFromPayload, ctx.job.studioId, ctx.job.connectionId);
    if (!link) return { code: "terminal_conflict", errorCode: "orphan_link_not_owned" };
    if (link.connectionId !== ctx.job.connectionId || link.studioId !== ctx.job.studioId) {
      return { code: "terminal_conflict", errorCode: "orphan_link_mismatch" };
    }
    if (link.deletedAt) return { code: "ok_noop_tombstone_deleted" };
    return await (link.googleEventId ? realDelete(ctx, deps, link) : placeholderDelete(ctx, deps, link));
  } catch (e) {
    if (e instanceof OpsStoreError) return { code: "retry_transient", errorCode: "db_read_failed" };
    throw e;
  }
}

// The approved dormant operations map. Imported only by server-only worker
// modules; no app route wires it, and the worker + all studio flags remain OFF.
export function createCalendarSyncOperations(deps: OperationDeps): SyncOperations {
  return {
    "event.create": (ctx) => handleUpsert(ctx, deps),
    "event.update": (ctx) => handleUpsert(ctx, deps),
    "event.delete": (ctx) => handleDelete(ctx, deps),
  };
}
