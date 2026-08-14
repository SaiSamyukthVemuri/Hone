import { describe, expect, it } from "vitest";
import type { ClaimedJob } from "@/lib/google-calendar/sync/job-result";
import type { AppointmentState, LinkRow } from "@/lib/google-calendar/sync/link-transition-store";
import { evaluateStaleFence } from "@/lib/google-calendar/sync/stale-fence";

// Phase B2.3-c1: the pre-bind execution-time stale fence (Decision G / §6).

function job(over: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: "job-1", studioId: "s1", connectionId: "c1", opType: "event.update",
    honeEntityType: "appointment", honeEntityId: "a1", payload: { sync_version: 3 },
    idempotencyKey: "k", attempts: 1, maxAttempts: 8, claimToken: "t",
    leaseExpiresAt: "2026-07-15T00:00:00Z", priority: 100, ...over,
  };
}
function appt(over: Partial<AppointmentState> = {}): AppointmentState {
  return { id: "a1", studioId: "s1", status: "confirmed", syncVersion: 3, startsAt: "2026-07-15T14:00:00Z", endsAt: "2026-07-15T15:00:00Z", studioTimezone: "UTC", ...over };
}
function link(over: Partial<LinkRow> = {}): LinkRow {
  return { id: "l1", studioId: "s1", connectionId: "c1", honeEntityType: "appointment", honeEntityId: "a1", googleCalendarId: "cal", googleEventId: null, googleIcalUid: null, googleEtag: null, lastHoneVersion: 0, syncStatus: "pending", deletedAt: null, ...over };
}

describe("evaluateStaleFence", () => {
  it("placeholder link -> create-and-bind", () => {
    expect(evaluateStaleFence({ job: job(), appointment: appt(), link: link() })).toEqual({ kind: "proceed", mode: "create" });
  });

  it("real link, not yet applied -> update", () => {
    const l = link({ googleEventId: "hone1x", lastHoneVersion: 2 });
    expect(evaluateStaleFence({ job: job(), appointment: appt(), link: l })).toEqual({ kind: "proceed", mode: "update" });
  });

  it("a newer desired version supersedes the job (no Google call)", () => {
    expect(evaluateStaleFence({ job: job({ payload: { sync_version: 2 } }), appointment: appt({ syncVersion: 3 }), link: link() }))
      .toEqual({ kind: "noop", code: "ok_noop_superseded" });
  });

  it("already applied requires google_event_id AND version (crash-recovery no-op)", () => {
    const applied = link({ googleEventId: "hone1x", lastHoneVersion: 3 });
    expect(evaluateStaleFence({ job: job(), appointment: appt(), link: applied })).toEqual({ kind: "noop", code: "ok_noop_superseded" });
  });

  it("a placeholder NEVER proves completion by merely existing", () => {
    // google_event_id null + last_hone_version high must still resolve to create.
    const weird = link({ googleEventId: null, lastHoneVersion: 99 });
    expect(evaluateStaleFence({ job: job(), appointment: appt(), link: weird })).toEqual({ kind: "proceed", mode: "create" });
  });

  it("cancelled/completed appointment is not a create/update target", () => {
    expect(evaluateStaleFence({ job: job(), appointment: appt({ status: "cancelled" }), link: link() })).toEqual({ kind: "noop", code: "ok_noop_superseded" });
  });

  it("delete: proceeds for a live link; superseded when the appt returned confirmed at a newer version", () => {
    const j = job({ opType: "event.delete", payload: { sync_version: 3 } });
    expect(evaluateStaleFence({ job: j, appointment: appt({ status: "cancelled" }), link: link({ googleEventId: "hone1x" }) })).toEqual({ kind: "proceed", mode: "delete" });
    expect(evaluateStaleFence({ job: j, appointment: appt({ status: "confirmed", syncVersion: 5 }), link: link({ googleEventId: "hone1x" }) })).toEqual({ kind: "noop", code: "ok_noop_superseded" });
    expect(evaluateStaleFence({ job: j, appointment: null, link: null })).toEqual({ kind: "noop", code: "ok_noop_no_active_link" });
  });

  it("a link owned by a different entity is a conflict", () => {
    expect(evaluateStaleFence({ job: job(), appointment: appt(), link: link({ honeEntityId: "other" }) })).toEqual({ kind: "conflict" });
  });
});
