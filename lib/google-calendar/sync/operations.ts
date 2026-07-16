import "server-only";
import { deriveEventId, verifyEventMarker } from "./event-id";
import type { GoogleError } from "./errors";
import type { GoogleEventResource, GoogleRestClient } from "./google-rest-client";
import type { SyncOperationContext, SyncOperations } from "./handler";
import type { JobResult } from "./job-result";
import type { AppointmentState, LinkRow, OpsLinkStore, TransitionResult } from "./link-transition-store";
import { buildAppointmentEventPayload } from "./serializer";
import { evaluateStaleFence, jobSyncVersion } from "./stale-fence";

// Google Calendar — Phase B2.3-c1: the real event operations (create / update /
// delete) plus provider reconciliation. DORMANT: this module is imported only by
// server-only worker modules; no app route wires it, and the worker/flags are OFF.
//
// Every operation persists LINK state exclusively through the transactional
// calendar_event_link_transition RPC (via the injected store) and NEVER
// transitions the outbox row — the existing claim -> handle ->
// record_calendar_sync_result adapter is the sole outbox authority. A cancelled
// Google event is NEVER bound as synced; a fresh provider lifecycle always comes
// from a fresh link row (rotate_for_recreate → new link id → new deterministic id).

export type OperationDeps = {
  rest: GoogleRestClient;
  store: OpsLinkStore;
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

// Map a GoogleError the operation does not special-case to a JobResult.
function mapGoogleErrorDefault(err: GoogleError): JobResult {
  switch (err.kind) {
    case "insufficient_scope":
      return { code: "terminal_insufficient_scope", errorCode: err.code };
    case "rate_limited":
      return { code: "retry_rate_limited", errorCode: err.code, retryAfterSeconds: err.retryAfterSeconds ?? undefined };
    case "token_expired":
      return { code: "retry_transient", errorCode: err.code };
    case "config_error":
      return { code: "retry_ineligible", errorCode: err.code };
    default:
      return { code: "retry_transient", errorCode: err.code };
  }
}

// Map a link-transition rejection to a JobResult. A lost claim / stale version is
// a benign no-op (a newer op owns the row); a foreign-id or already-bound-other is
// a hard conflict.
function mapTransitionReject(t: TransitionResult): JobResult {
  switch (t.code) {
    case "foreign_event_conflict":
    case "already_bound_other":
      return { code: "terminal_conflict", errorCode: t.code };
    case "stale_token":
    case "outbox_not_processing":
    case "stale_version":
    case "link_deleted":
    case "link_mismatch":
    case "superseded":
      return { code: "ok_noop_superseded", errorCode: t.code };
    case "link_not_found":
      return { code: "ok_noop_no_active_link", errorCode: t.code };
    default:
      return { code: "retry_transient", errorCode: `transition_${t.code}` };
  }
}

function isNetwork(err: GoogleError): boolean {
  return err.kind === "transient" && (err.code === "network_timeout" || err.code === "network_error");
}

// Bind a confirmed provider event onto the link (transactional). `ok` on success;
// the adapter then records the outbox row `done`.
async function bindConfirmed(
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
  return mapTransitionReject(t);
}

// GET the deterministic id and reconcile. Returns a JobResult, or null when the
// event is definitively absent (404/410) and the caller may safely insert.
async function reconcileByGet(
  ctx: SyncOperationContext,
  deps: OperationDeps,
  link: LinkRow,
  appointment: AppointmentState,
  eventId: string,
): Promise<JobResult | null> {
  const got = await deps.rest.getEvent({ accessToken: ctx.accessToken, calendarId: link.googleCalendarId, eventId });
  if (got.ok) {
    const verdict = verifyEventMarker(extractPrivate(got.event), link.id);
    if (verdict !== "match") return { code: "terminal_conflict", errorCode: "foreign_event" };
    if (got.event.status === "cancelled") return rotateAndCreate(ctx, deps, link, appointment);
    return bindConfirmed(ctx, deps, link, eventId, got.event, got.etag);
  }
  if (got.error.kind === "not_found") return null; // safe to insert
  return mapGoogleErrorDefault(got.error);
}

async function doInsert(
  ctx: SyncOperationContext,
  deps: OperationDeps,
  link: LinkRow,
  appointment: AppointmentState,
  eventId: string,
): Promise<JobResult> {
  const ser = buildAppointmentEventPayload({
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
    studioTimezone: appointment.studioTimezone,
    linkId: link.id,
  });
  if (!ser.ok) return { code: "terminal_conflict", errorCode: `serialize_${ser.reason}` };
  const res = await deps.rest.insertEvent({
    accessToken: ctx.accessToken,
    calendarId: link.googleCalendarId,
    event: { id: eventId, ...ser.payload },
  });
  if (res.ok) return bindConfirmed(ctx, deps, link, eventId, res.event, res.etag);

  const err = res.error;
  if (err.kind === "conflict") {
    // 409 duplicate — GET the id and adopt/rotate/conflict. A 409-then-404 is a
    // contradictory provider state: bounded retry (do NOT blind-insert again).
    const rec = await reconcileByGet(ctx, deps, link, appointment, eventId);
    return rec ?? { code: "retry_transient", errorCode: "conflict_then_absent" };
  }
  if (isNetwork(err)) {
    // Ambiguous — the insert may have created the event. GET-first before any
    // further insert; if absent, a bounded retry.
    const rec = await reconcileByGet(ctx, deps, link, appointment, eventId);
    return rec ?? { code: "retry_transient", errorCode: err.code };
  }
  return mapGoogleErrorDefault(err);
}

// Rotate to a fresh placeholder link (a new provider lifecycle) then create under
// the fresh deterministic id.
async function rotateAndCreate(
  ctx: SyncOperationContext,
  deps: OperationDeps,
  link: LinkRow,
  appointment: AppointmentState,
): Promise<JobResult> {
  const t = await deps.store.transition({
    action: "rotate_for_recreate",
    outboxId: ctx.job.id,
    claimToken: ctx.job.claimToken,
    linkId: link.id,
    studioId: link.studioId,
    connectionId: link.connectionId,
    honeEntityType: link.honeEntityType,
    honeEntityId: link.honeEntityId,
  });
  if (t.status !== "ok" || !t.linkId) {
    return mapTransitionReject(t);
  }
  const fresh = await deps.store.loadLinkById(t.linkId);
  if (!fresh) return { code: "retry_transient", errorCode: "rotate_reload_missing" };
  return doInsert(ctx, deps, fresh, appointment, deriveEventId(fresh.studioId, fresh.id));
}

// Create-and-bind (placeholder event.update) OR create (event.create). On a retry
// (attempts > 1) a prior attempt may have created the event; GET-first for
// idempotency before any insert.
async function createAndBind(
  ctx: SyncOperationContext,
  deps: OperationDeps,
  link: LinkRow,
  appointment: AppointmentState,
): Promise<JobResult> {
  const eventId = deriveEventId(link.studioId, link.id);
  if (ctx.job.attempts > 1) {
    const rec = await reconcileByGet(ctx, deps, link, appointment, eventId);
    if (rec) return rec; // resolved (bind/rotate/conflict/retry); null => safe to insert
  }
  return doInsert(ctx, deps, link, appointment, eventId);
}

// Real update against a bound link. 404/410 or a cancelled remote rotates to a
// fresh lifecycle; a stale etag (412) re-GETs and reapplies.
async function realUpdate(
  ctx: SyncOperationContext,
  deps: OperationDeps,
  link: LinkRow,
  appointment: AppointmentState,
): Promise<JobResult> {
  const providerId = link.googleEventId as string;
  const ser = buildAppointmentEventPayload({
    startsAt: appointment.startsAt,
    endsAt: appointment.endsAt,
    studioTimezone: appointment.studioTimezone,
    linkId: link.id,
  });
  if (!ser.ok) return { code: "terminal_conflict", errorCode: `serialize_${ser.reason}` };

  const res = await deps.rest.patchEvent({
    accessToken: ctx.accessToken,
    calendarId: link.googleCalendarId,
    eventId: providerId,
    event: ser.payload,
    etag: link.googleEtag,
  });
  if (res.ok) {
    if (res.event.status === "cancelled") return rotateAndCreate(ctx, deps, link, appointment);
    return updateConfirmed(ctx, deps, link, providerId, res.event, res.etag);
  }
  const err = res.error;
  if (err.kind === "not_found") return rotateAndCreate(ctx, deps, link, appointment); // 404/410 -> recreate
  if (err.kind === "precondition_failed") {
    // Stale etag: re-GET, re-evaluate, reapply once with the fresh etag.
    const got = await deps.rest.getEvent({ accessToken: ctx.accessToken, calendarId: link.googleCalendarId, eventId: providerId });
    if (got.ok) {
      if (got.event.status === "cancelled") return rotateAndCreate(ctx, deps, link, appointment);
      const res2 = await deps.rest.patchEvent({
        accessToken: ctx.accessToken,
        calendarId: link.googleCalendarId,
        eventId: providerId,
        event: ser.payload,
        etag: got.etag,
      });
      if (res2.ok) return updateConfirmed(ctx, deps, link, providerId, res2.event, res2.etag);
      if (res2.error.kind === "not_found") return rotateAndCreate(ctx, deps, link, appointment);
      return { code: "retry_transient", errorCode: "retry_after_412" };
    }
    if (got.error.kind === "not_found") return rotateAndCreate(ctx, deps, link, appointment);
    return mapGoogleErrorDefault(got.error);
  }
  if (err.kind === "conflict") return { code: "terminal_conflict", errorCode: "update_conflict" };
  return mapGoogleErrorDefault(err);
}

async function updateConfirmed(
  ctx: SyncOperationContext,
  deps: OperationDeps,
  link: LinkRow,
  providerId: string,
  event: GoogleEventResource,
  etag: string | null,
): Promise<JobResult> {
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
  return { code: "retry_transient", errorCode: `mark_deleted_${t.code}` };
}

async function realDelete(ctx: SyncOperationContext, deps: OperationDeps, link: LinkRow): Promise<JobResult> {
  const providerId = link.googleEventId as string;
  const res = await deps.rest.deleteEvent({
    accessToken: ctx.accessToken,
    calendarId: link.googleCalendarId,
    eventId: providerId,
    etag: link.googleEtag,
  });
  if (res.ok) return finalizeDelete(ctx, deps, link);
  const err = res.error;
  if (err.kind === "not_found") return finalizeDelete(ctx, deps, link); // 404/410 converged
  if (err.kind === "precondition_failed") {
    const got = await deps.rest.getEvent({ accessToken: ctx.accessToken, calendarId: link.googleCalendarId, eventId: providerId });
    if (got.ok) {
      if (got.event.status === "cancelled") return finalizeDelete(ctx, deps, link);
      const res2 = await deps.rest.deleteEvent({ accessToken: ctx.accessToken, calendarId: link.googleCalendarId, eventId: providerId, etag: got.etag });
      if (res2.ok || res2.error.kind === "not_found") return finalizeDelete(ctx, deps, link);
      return { code: "retry_transient", errorCode: "delete_after_412" };
    }
    if (got.error.kind === "not_found") return finalizeDelete(ctx, deps, link);
    return mapGoogleErrorDefault(got.error);
  }
  return mapGoogleErrorDefault(err);
}

// GET-verified placeholder orphan delete: NEVER a blind DELETE against a derived
// id. Verify ownership via the marker before any provider delete.
async function placeholderDelete(ctx: SyncOperationContext, deps: OperationDeps, link: LinkRow): Promise<JobResult> {
  const eventId = deriveEventId(link.studioId, link.id);
  const got = await deps.rest.getEvent({ accessToken: ctx.accessToken, calendarId: link.googleCalendarId, eventId });
  if (got.ok) {
    const verdict = verifyEventMarker(extractPrivate(got.event), link.id);
    if (verdict !== "match") return { code: "terminal_conflict", errorCode: "placeholder_foreign" };
    if (got.event.status === "cancelled") return finalizeDelete(ctx, deps, link); // ours, already gone
    const res = await deps.rest.deleteEvent({ accessToken: ctx.accessToken, calendarId: link.googleCalendarId, eventId, etag: got.etag });
    if (res.ok || res.error.kind === "not_found") return finalizeDelete(ctx, deps, link);
    return mapGoogleErrorDefault(res.error);
  }
  if (got.error.kind === "not_found") return finalizeDelete(ctx, deps, link); // never created -> converged
  return mapGoogleErrorDefault(got.error);
}

async function loadSnapshot(ctx: SyncOperationContext, deps: OperationDeps) {
  const entityType = ctx.job.honeEntityType;
  const entityId = ctx.job.honeEntityId;
  const appointment = entityId ? await deps.store.loadAppointmentState(entityId, ctx.job.studioId) : null;
  const link =
    entityType && entityId ? await deps.store.loadActiveLinkByEntity(ctx.job.studioId, entityType, entityId) : null;
  return { appointment, link };
}

// event.create AND placeholder event.update share the upsert contract: the fence
// resolves to create-and-bind (placeholder) or a real update.
async function handleUpsert(ctx: SyncOperationContext, deps: OperationDeps): Promise<JobResult> {
  if (ctx.job.honeEntityType === "timed_block") {
    return { code: "retry_ineligible", errorCode: "operation_not_implemented" };
  }
  const { appointment, link } = await loadSnapshot(ctx, deps);
  const fence = evaluateStaleFence({ job: ctx.job, appointment, link });
  if (fence.kind === "noop") return { code: fence.code };
  if (fence.kind === "conflict") return { code: "terminal_conflict", errorCode: "entity_link_mismatch" };
  if (!link || !appointment) return { code: "ok_noop_no_active_link" };
  if (fence.mode === "create") return createAndBind(ctx, deps, link, appointment);
  if (fence.mode === "update") return realUpdate(ctx, deps, link, appointment);
  return { code: "ok_noop_superseded" };
}

async function handleDelete(ctx: SyncOperationContext, deps: OperationDeps): Promise<JobResult> {
  if (ctx.job.honeEntityType === "timed_block") {
    return { code: "retry_ineligible", errorCode: "operation_not_implemented" };
  }
  const payload = ctx.job.payload ?? {};
  const linkIdFromPayload = typeof payload["hone_link_id"] === "string" ? (payload["hone_link_id"] as string) : null;

  // Entity-carrying delete (appointment cancel or hard-delete).
  if (ctx.job.honeEntityId && ctx.job.honeEntityType) {
    let link = await deps.store.loadActiveLinkByEntity(ctx.job.studioId, ctx.job.honeEntityType, ctx.job.honeEntityId);
    if (!link && linkIdFromPayload) link = await deps.store.loadLinkById(linkIdFromPayload);
    const appointment = await deps.store.loadAppointmentState(ctx.job.honeEntityId, ctx.job.studioId);
    const fence = evaluateStaleFence({ job: ctx.job, appointment, link });
    if (fence.kind === "noop") return { code: fence.code };
    if (fence.kind === "conflict") return { code: "terminal_conflict", errorCode: "delete_entity_mismatch" };
    if (!link) return { code: "ok_noop_no_active_link" };
    if (link.deletedAt) return { code: "ok_noop_tombstone_deleted" };
    return link.googleEventId ? realDelete(ctx, deps, link) : placeholderDelete(ctx, deps, link);
  }

  // Entity-less orphan/tombstone delete (repair_enqueue_orphan_link_delete).
  if (!linkIdFromPayload) return { code: "ok_noop_no_active_link" };
  const link = await deps.store.loadLinkById(linkIdFromPayload);
  if (!link) return { code: "ok_noop_no_active_link" };
  if (link.deletedAt) return { code: "ok_noop_tombstone_deleted" };
  return link.googleEventId ? realDelete(ctx, deps, link) : placeholderDelete(ctx, deps, link);
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
