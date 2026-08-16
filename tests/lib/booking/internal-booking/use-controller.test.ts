/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import {
  useInternalBookingController,
  type LoadResult,
} from "@/lib/booking/internal-booking/use-controller";
import type { InternalBookingCandidateIdentity } from "@/lib/booking/internal-booking/candidate";
import { availabilityKey } from "@/lib/booking/internal-booking/candidate";
import { utcInstantFromLocal } from "@/lib/booking/tz";
import { deferred, flush, renderHook } from "./hook-harness";

// THE REQUEST LIFECYCLE, MOUNTED.
//
// Two of the three P1 defects in the first foundation lived here, and both were
// invisible to the reducer suite: the effect cancelled its own request the
// moment the reducer recorded that the request had started, and a length change
// left an approval alive because it never reached the reducer at all.
//
// These tests mount the real hook and drive real promises. Nothing is grepped.

const TZ = "America/Toronto";
const DATE = "2026-08-20";

const ID = (
  over: Partial<InternalBookingCandidateIdentity> = {},
): InternalBookingCandidateIdentity => ({
  clientId: "client-1",
  serviceId: "svc-1",
  date: DATE,
  targetPractitionerId: "prac-A",
  capacityMode: true,
  timezone: TZ,
  ...over,
});

const iso = (d: string, t: string) => utcInstantFromLocal(d, t, TZ).toISOString();

const SNAP = (over: Partial<{ serviceDurationMinutes: number }> = {}) => ({
  serviceDurationMinutes: 60,
  window: { kind: "open" as const, openTime: "09:00", closeTime: "17:00" },
  slots: [{ start: iso(DATE, "10:00"), end: iso(DATE, "11:00"), startLabel: "10:00 AM" }],
  ...over,
});

type Props = {
  identity: InternalBookingCandidateIdentity;
  isOwner: boolean;
  customDurationMinutes: number | null;
  load: (id: InternalBookingCandidateIdentity) => Promise<LoadResult>;
  onLoadError?: (e: string) => void;
};

const mount = (props: Partial<Props> & Pick<Props, "load">) =>
  renderHook((p: Props) => useInternalBookingController(p), {
    identity: ID(),
    isOwner: true,
    customDurationMinutes: null,
    ...props,
  });

describe("HOOK A — recording that a request started must not cancel it", () => {
  it("a normal load commits its snapshot", async () => {
    const d = deferred<LoadResult>();
    const load = vi.fn(() => d.promise);
    const h = mount({ load });

    // The request was issued exactly once, and the reducer recorded it.
    expect(load).toHaveBeenCalledTimes(1);
    expect(h.current.loading, "the start is recorded").toBe(true);
    expect(h.current.state.loadingToken).not.toBeNull();

    // THE DEFECT: dispatching SLOT_REQUEST_STARTED used to flip the derived
    // `needsLoad` dependency, re-run this effect and fire its own cleanup, so
    // the continuation below returned without ever committing.
    await flush(() => d.resolve({ ok: true, snapshot: SNAP() }));

    expect(h.current.loading, "no longer loading").toBe(false);
    expect(h.current.decision.snapshotStale, "the result is authoritative").toBe(false);
    expect(h.current.state.snapshot?.serviceDurationMinutes).toBe(60);
    expect(h.current.slots).toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(1);
    h.unmount();
  });

  it("an incomplete candidate asks nothing at all", () => {
    const load = vi.fn(() => Promise.resolve({ ok: true, snapshot: SNAP() } as LoadResult));
    const h = mount({ identity: ID({ serviceId: null }), load });
    expect(load).not.toHaveBeenCalled();
    expect(h.current.loading).toBe(false);
    h.unmount();
  });
});

describe("HOOK B — an identity change supersedes the request in flight", () => {
  it("the new candidate commits; the old one cannot, even resolving last", async () => {
    const a = deferred<LoadResult>();
    const b = deferred<LoadResult>();
    const seen: (string | null)[] = [];
    const load = vi.fn((id: InternalBookingCandidateIdentity) => {
      seen.push(id.date);
      return seen.length === 1 ? a.promise : b.promise;
    });
    const h = mount({ load });
    expect(load).toHaveBeenCalledTimes(1);

    // Date A -> B while A is still outstanding.
    h.rerender({
      identity: ID({ date: "2026-08-21" }),
      isOwner: true,
      customDurationMinutes: null,
      load,
    });
    expect(load).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([DATE, "2026-08-21"]);

    await flush(() => b.resolve({ ok: true, snapshot: SNAP() }));
    expect(h.current.state.snapshot?.availabilityKey).toBe(
      availabilityKey(ID({ date: "2026-08-21" })),
    );

    // A resolves LAST and must change nothing.
    const before = h.current.state;
    await flush(() => a.resolve({ ok: true, snapshot: SNAP({ serviceDurationMinutes: 999 }) }));
    expect(h.current.state.snapshot?.availabilityKey).toBe(
      availabilityKey(ID({ date: "2026-08-21" })),
    );
    expect(h.current.state.snapshot?.serviceDurationMinutes).toBe(60);
    expect(h.current.state).toBe(before);
    h.unmount();
  });
});

describe("HOOK C — a failed load stops, and does not hot-loop", () => {
  it("authority is withdrawn and exactly one request was made", async () => {
    const d = deferred<LoadResult>();
    const load = vi.fn(() => d.promise);
    const onLoadError = vi.fn();
    const h = mount({ load, onLoadError });

    await flush(() => d.resolve({ ok: false, error: "boom" }));

    expect(onLoadError).toHaveBeenCalledWith("boom");
    expect(h.current.loadFailed).toBe(true);
    expect(h.current.decision.snapshotStale).toBe(true);
    expect(h.current.decision.canConfirm).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);

    // Several further renders must not turn the failure into a retry storm.
    for (let i = 0; i < 3; i++) {
      h.rerender({ identity: ID(), isOwner: true, customDurationMinutes: null, load });
    }
    await flush();
    expect(load, "no hot loop").toHaveBeenCalledTimes(1);
    h.unmount();
  });

  it("a thrown loader is a failure, not an unhandled rejection", async () => {
    const load = vi.fn(() => Promise.reject(new Error("network")));
    const onLoadError = vi.fn();
    const h = mount({ load, onLoadError });
    await flush();
    expect(h.current.loadFailed).toBe(true);
    expect(onLoadError).toHaveBeenCalledTimes(1);
    h.unmount();
  });
});

describe("HOOK D — retry is explicit, and issues exactly one replacement", () => {
  it("the same candidate reloads and regains authority", async () => {
    const first = deferred<LoadResult>();
    const second = deferred<LoadResult>();
    let n = 0;
    const load = vi.fn((_id: InternalBookingCandidateIdentity) =>
      ++n === 1 ? first.promise : second.promise,
    );
    const h = mount({ load });

    await flush(() => first.resolve({ ok: false, error: "boom" }));
    expect(h.current.loadFailed).toBe(true);

    await flush(() => h.current.retry());
    expect(load, "exactly one replacement").toHaveBeenCalledTimes(2);
    expect(load.mock.calls[1]?.[0]).toEqual(ID()); // identity unchanged
    expect(h.current.loading).toBe(true);
    expect(h.current.loadFailed).toBe(false);

    await flush(() => second.resolve({ ok: true, snapshot: SNAP() }));
    expect(h.current.decision.snapshotStale).toBe(false);
    expect(h.current.slots).toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(2);
    h.unmount();
  });
});

describe("HOOK F — an already-answered question is not asked twice", () => {
  it("returning to a candidate whose answer is still held does not refetch", async () => {
    const a = deferred<LoadResult>();
    const b = deferred<LoadResult>();
    let n = 0;
    const load = vi.fn((_id: InternalBookingCandidateIdentity) =>
      ++n === 1 ? a.promise : b.promise,
    );
    const h = mount({ load });
    await flush(() => a.resolve({ ok: true, snapshot: SNAP() }));
    expect(load).toHaveBeenCalledTimes(1);

    const at = (date: string) => ({
      identity: ID({ date }),
      isOwner: true,
      customDurationMinutes: null,
      load,
    });
    h.rerender(at("2026-08-21")); // B, left in flight
    expect(load).toHaveBeenCalledTimes(2);
    h.rerender(at(DATE)); // back to A
    await flush();

    // The request effect re-runs (its key changed twice) but must not re-ask a
    // question whose answer is still held -- this is where the derived
    // `needsLoad` and the effect that issues requests have to agree.
    expect(load, "A was already answered").toHaveBeenCalledTimes(2);
    expect(h.current.decision.snapshotStale, "A is authoritative again").toBe(false);
    h.unmount();
  });
});

describe("HOOK E — state that is not the question leaves the request alive", () => {
  it("a custom-duration change does not cancel or re-issue the load", async () => {
    const d = deferred<LoadResult>();
    const load = vi.fn(() => d.promise);
    const h = mount({ load });
    expect(load).toHaveBeenCalledTimes(1);

    // The chosen length is controller state, but it is NOT part of the
    // availability question -- the server derives the interval from the locked
    // service row -- so it must neither refetch nor kill the request in flight.
    h.rerender({ identity: ID(), isOwner: true, customDurationMinutes: 90, load });
    await flush();
    expect(load, "no refetch").toHaveBeenCalledTimes(1);
    expect(h.current.state.customDurationMinutes, "but the reducer knows").toBe(90);

    await flush(() => d.resolve({ ok: true, snapshot: SNAP() }));
    expect(h.current.decision.snapshotStale, "the request survived").toBe(false);
    h.unmount();
  });

  it("an ownership change does not disturb the request either", async () => {
    const d = deferred<LoadResult>();
    const load = vi.fn(() => d.promise);
    const h = mount({ load });
    h.rerender({ identity: ID(), isOwner: false, customDurationMinutes: null, load });
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    await flush(() => d.resolve({ ok: true, snapshot: SNAP() }));
    expect(h.current.decision.snapshotStale).toBe(false);
    h.unmount();
  });
});
