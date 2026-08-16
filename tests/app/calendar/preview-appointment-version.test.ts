import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { previewAppointmentVersion } from "../../../app/(app)/calendar/preview-appointment-version";

// The rule that decides WHICH version of the appointment the drawer describes.
//
// Why it is worth testing directly rather than through a source grep: the values
// it returns are not decoration. startsAt/endsAt become 0133's
// p_expected_starts_at / p_expected_ends_at and any drift is refused as
// `stale_appointment`; durationMinutes is the stored column 0133 preserves while
// computing the new end; status decides both the label the practitioner reads
// and whether lifecycle actions are offered at all.
//
// Two separate defects came from choosing per-field at the point of use: a fresh
// status beside a stale time, and a fresh gate over a stale move payload. This
// rule exists so there is one choice.

const GRID = {
  startsAt: "2026-08-20T17:00:00.000Z", // 13:00 local
  endsAt: "2026-08-20T18:00:00.000Z",
  durationMinutes: 60,
  status: "confirmed",
};

const FRESH = {
  startsAt: "2026-08-20T18:00:00.000Z", // moved to 14:00 local
  endsAt: "2026-08-20T19:00:00.000Z",
  durationMinutes: 60,
  status: "confirmed",
};

describe("the re-read row wins, in full", () => {
  it("selects the DETAIL schedule when the appointment moved under the grid", () => {
    const r = previewAppointmentVersion({ grid: GRID, detail: FRESH, detailIsCurrent: true });
    expect(r.startsAt).toBe(FRESH.startsAt);
    expect(r.endsAt).toBe(FRESH.endsAt);
    expect(r.fresh).toBe(true);
    // Neither stale timestamp survives.
    expect(r.startsAt).not.toBe(GRID.startsAt);
    expect(r.endsAt).not.toBe(GRID.endsAt);
  });

  it("selects the DETAIL status — a cancellation elsewhere is visible here", () => {
    // P2-A. The grid was rendered while the booking was active; it has been
    // cancelled since. The drawer must describe the row as it IS.
    const r = previewAppointmentVersion({
      grid: GRID,
      detail: { ...FRESH, status: "cancelled" },
      detailIsCurrent: true,
    });
    expect(r.status).toBe("cancelled");
    expect(r.status).not.toBe(GRID.status);
    expect(r.fresh).toBe(true);
  });

  it("still prefers detail when the TIMESTAMPS agree (falsifiable positive control)", () => {
    // A positive control has to be able to fail. Giving grid and detail
    // identical primitives made an implementation that wrongly returned `grid`
    // pass, so it asserted nothing. The timestamps still agree — that is the
    // case under test — but the stored duration and status differ, so the two
    // sources are observably distinct.
    const detail = {
      startsAt: GRID.startsAt,
      endsAt: GRID.endsAt,
      durationMinutes: 45,
      status: "completed",
    };
    const r = previewAppointmentVersion({ grid: GRID, detail, detailIsCurrent: true });
    expect(r.startsAt).toBe(GRID.startsAt);
    expect(r.durationMinutes).toBe(45);
    expect(r.status).toBe("completed");
    expect(r.durationMinutes).not.toBe(GRID.durationMinutes);
    expect(r.status).not.toBe(GRID.status);
  });
});

describe("stored duration is a FACT, never reconstructed from the span", () => {
  // 0010 range-checks duration_minutes (5..480) and says nothing about
  // ends_at - starts_at, so a row where they disagree is valid. 0133 preserves
  // the STORED column and computes the new end from it, never trusting a
  // caller-supplied end. Reconstructing it would make the dialog announce a
  // number the command has already decided to ignore.
  const MISMATCH = {
    startsAt: "2026-08-20T17:00:00.000Z", // 13:00
    endsAt: "2026-08-20T18:30:00.000Z", // 14:30 — a 90 minute SPAN
    durationMinutes: 60, // but the STORED duration is 60
    status: "confirmed",
  };

  it("reports the stored 60, not the 90 minute span", () => {
    const r = previewAppointmentVersion({ grid: GRID, detail: MISMATCH, detailIsCurrent: true });
    expect(r.durationMinutes).toBe(60);
    const spanMinutes =
      (new Date(MISMATCH.endsAt).getTime() - new Date(MISMATCH.startsAt).getTime()) / 60_000;
    expect(spanMinutes).toBe(90);
    expect(r.durationMinutes).not.toBe(spanMinutes);
  });

  it("a span disagreeing with the stored duration is NOT a reason to fall back", () => {
    const r = previewAppointmentVersion({ grid: GRID, detail: MISMATCH, detailIsCurrent: true });
    expect(r.fresh).toBe(true);
    expect(r.startsAt).toBe(MISMATCH.startsAt);
    expect(r.endsAt).toBe(MISMATCH.endsAt);
  });

  it("never forces the span and the duration into agreement", () => {
    const r = previewAppointmentVersion({ grid: GRID, detail: MISMATCH, detailIsCurrent: true });
    expect(r.endsAt).toBe(MISMATCH.endsAt);
    expect(r.durationMinutes).toBe(MISMATCH.durationMinutes);
  });
});

describe("fail BACK, never forward, and never into a hybrid", () => {
  it("falls back to the grid before any detail has loaded", () => {
    const r = previewAppointmentVersion({ grid: GRID, detail: null, detailIsCurrent: true });
    expect(r).toEqual({ ...GRID, fresh: false });
  });

  it("marks the fallback NOT fresh, so callers cannot mistake it for verified", () => {
    // `fresh` is what the drawer gates lifecycle actions on. A grid snapshot is
    // not a verified current state.
    expect(previewAppointmentVersion({ grid: GRID, detail: null, detailIsCurrent: true }).fresh).toBe(false);
  });

  it("falls back when a timestamp does not parse, rather than sending garbage", () => {
    const detail = { ...FRESH, startsAt: "not-a-date" };
    const r = previewAppointmentVersion({ grid: GRID, detail, detailIsCurrent: true });
    expect(r).toEqual({ ...GRID, fresh: false });
  });

  it("falls back TOTALLY when the stored duration is unusable — never a hybrid", () => {
    // The fresh timestamps are perfectly good here and are still not used:
    // pairing them with the grid's duration would describe a version that never
    // existed. Fallback is per-VERSION, not per-field.
    const detail = { ...FRESH, durationMinutes: 0 };
    const r = previewAppointmentVersion({ grid: GRID, detail, detailIsCurrent: true });
    expect(r).toEqual({ ...GRID, fresh: false });
    expect(r.startsAt).not.toBe(FRESH.startsAt);
  });

  it("falls back when the status is blank, which would have rendered as Upcoming", () => {
    const detail = { ...FRESH, status: "   " };
    const r = previewAppointmentVersion({ grid: GRID, detail, detailIsCurrent: true });
    expect(r).toEqual({ ...GRID, fresh: false });
  });
});

describe("the drawer routes ALL of it through this one rule", () => {
  const DRAWER = readFileSync(
    path.resolve(__dirname, "../../../app/(app)/calendar/AppointmentPreviewDrawer.tsx"),
    "utf8",
  );

  it("derives the version once and does not re-decide per field", () => {
    expect(DRAWER).toContain("previewAppointmentVersion({");
    // The old per-field choice is what produced both defects.
    expect(DRAWER).not.toContain("detail?.status ?? a.status");
    expect(DRAWER).not.toContain("detail?.endsAt ?? a.ends_at");
  });

  it("renders the summary from the version, not the grid row", () => {
    expect(DRAWER).toContain("dayLabel(version.startsAt, studioTimezone)");
    expect(DRAWER).toContain("new Date(version.startsAt)");
    expect(DRAWER).toContain("{version.durationMinutes}m");
  });

  it("labels every status the display mapper can return, including cancelled", () => {
    expect(DRAWER).toContain('ds === "cancelled"');
    expect(DRAWER).toContain('"Cancelled"');
  });

  it("gates actions and the move payload on that same version", () => {
    expect(DRAWER).toContain("version.fresh");
    expect(DRAWER).toMatch(/startsAt:\s*version\.startsAt/);
    expect(DRAWER).toMatch(/endsAt:\s*version\.endsAt/);
    expect(DRAWER).toMatch(/durationMinutes:\s*version\.durationMinutes/);
  });

  it("the loader carries duration_minutes and status for it to use", () => {
    const LOADER = readFileSync(
      path.resolve(__dirname, "../../../lib/calendar/appointment-preview-detail.ts"),
      "utf8",
    );
    expect(LOADER).toMatch(/duration_minutes/);
    expect(LOADER).toMatch(/durationMinutes:\s*raw\.duration_minutes/);
    expect(LOADER).toMatch(/status:\s*raw\.status/);
  });
});

describe("currency is required for ACTION AUTHORITY, not just presence", () => {
  // A detail that was read successfully at some point is not thereby current
  // forever. When a refresh is in flight, or has failed, the held copy is the
  // last thing we saw — not the thing we are asserting. It may still be the
  // best DISPLAY we have; it may not authorize Cancel or Reschedule.
  it("a held detail that is no longer current is not fresh", () => {
    const r = previewAppointmentVersion({
      grid: GRID,
      detail: FRESH,
      detailIsCurrent: false,
    });
    expect(r.fresh).toBe(false);
  });

  it("still DISPLAYS the held detail — it is newer than the grid", () => {
    // "Loses authority" is not "is discarded". The grid is older still, and the
    // drawer renders its load-error line alongside, so showing the last
    // successful read is the honest fallback rather than reverting further back.
    const r = previewAppointmentVersion({
      grid: GRID,
      detail: FRESH,
      detailIsCurrent: false,
    });
    expect(r.startsAt).toBe(FRESH.startsAt);
    expect(r.endsAt).toBe(FRESH.endsAt);
  });

  it("a stale CANCELLED detail cannot authorize actions", () => {
    // Requirement 3, at the rule level: whatever the status, a non-current read
    // is not the basis for offering a lifecycle action.
    const r = previewAppointmentVersion({
      grid: GRID,
      detail: { ...FRESH, status: "cancelled" },
      detailIsCurrent: false,
    });
    expect(r.fresh).toBe(false);
  });

  it("a stale MOVED schedule cannot become the action authority", () => {
    // Requirement 4. These timestamps would otherwise be sent as 0133's
    // expected version on a row nobody has re-verified.
    const r = previewAppointmentVersion({
      grid: GRID,
      detail: { ...FRESH, startsAt: "2026-08-20T20:00:00.000Z" },
      detailIsCurrent: false,
    });
    expect(r.fresh).toBe(false);
  });

  it("currency alone does not rescue an unusable detail", () => {
    const r = previewAppointmentVersion({
      grid: GRID,
      detail: { ...FRESH, durationMinutes: 0 },
      detailIsCurrent: true,
    });
    expect(r).toEqual({ ...GRID, fresh: false });
  });
});
