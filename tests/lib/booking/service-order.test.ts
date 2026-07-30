import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyServiceMove,
  availableMoves,
  compareServicePosition,
  isServiceMove,
  normalizedSortOrder,
  sortServicesForSettings,
  sortVisibleServices,
  type OrderableService,
} from "@/lib/booking/service-order";

// Canonical service ordering (Chloe: "the service I want first cannot reliably
// reach the top").
//
// THE DEFECT THESE PIN. `services.sort_order` is `not null default 100` with no
// uniqueness and a PER-MODALITY allocator, so ties are the NORMAL state. The
// settings page ordered by (active, sort_order, name) while the reorder action
// ordered by sort_order ALONE — a partial order, resolved by Postgres in heap
// order, which changes after every UPDATE. The row at screen position N was
// routinely not the row the action found at index N, and when the action found
// the clicked row at index 0 it silently did nothing, forever.
//
// The fix is a TOTAL order — (sort_order, name, id) — shared by the settings
// list, the reorder action, the public booking page and migration 0161's RPC.

const svc = (
  id: string,
  name: string,
  sort_order: number,
  active = true,
): OrderableService => ({ id, name, sort_order, active });

describe("compareServicePosition is a TOTAL order", () => {
  it("orders by sort_order first", () => {
    expect(compareServicePosition(svc("a", "Zed", 10), svc("b", "Alpha", 20))).toBeLessThan(0);
  });

  it("breaks a sort_order tie by name", () => {
    expect(compareServicePosition(svc("b", "Alpha", 100), svc("a", "Zed", 100))).toBeLessThan(0);
  });

  it("breaks a name tie by id — the term that removes the LAST tie", () => {
    // Two services can legitimately share a name across modalities. Without this
    // term the database resolved the tie in heap order.
    expect(compareServicePosition(svc("a", "Same", 100), svc("b", "Same", 100))).toBeLessThan(0);
    expect(compareServicePosition(svc("b", "Same", 100), svc("a", "Same", 100))).toBeGreaterThan(0);
  });

  it("returns 0 only for the identical row", () => {
    expect(compareServicePosition(svc("a", "X", 10), svc("a", "X", 10))).toBe(0);
  });

  it("is deterministic regardless of input order — the whole point", () => {
    // Every row at the legacy default 100: the exact production shape.
    const rows = [
      svc("id-3", "Electrolysis 30", 100),
      svc("id-1", "Client Consultation", 100),
      svc("id-2", "Electrolysis 60", 100),
    ];
    const a = [...rows].sort(compareServicePosition).map((s) => s.id);
    const b = [...rows].reverse().sort(compareServicePosition).map((s) => s.id);
    const c = [rows[1], rows[2], rows[0]].sort(compareServicePosition).map((s) => s.id);
    expect(a).toEqual(b);
    expect(a).toEqual(c);
  });
});

describe("sortServicesForSettings", () => {
  it("sinks hidden services below every visible one", () => {
    const rows = [svc("h", "AAA hidden", 10, false), svc("v", "ZZZ visible", 90)];
    expect(sortServicesForSettings(rows).map((s) => s.id)).toEqual(["v", "h"]);
  });

  it("orders within each visibility bucket canonically", () => {
    const rows = [
      svc("v2", "B", 100),
      svc("v1", "A", 100),
      svc("h2", "D", 100, false),
      svc("h1", "C", 100, false),
    ];
    expect(sortServicesForSettings(rows).map((s) => s.id)).toEqual(["v1", "v2", "h1", "h2"]);
  });

  it("does not mutate the input", () => {
    const rows = [svc("b", "B", 20), svc("a", "A", 10)];
    const snapshot = rows.map((s) => s.id);
    sortServicesForSettings(rows);
    expect(rows.map((s) => s.id)).toEqual(snapshot);
  });
});

describe("sortVisibleServices — the order the booking surfaces must agree on", () => {
  it("drops hidden services entirely", () => {
    const rows = [svc("a", "A", 10), svc("h", "H", 20, false), svc("b", "B", 30)];
    expect(sortVisibleServices(rows).map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("a hidden service cannot shift the visible order", () => {
    const withHidden = [svc("a", "A", 10), svc("h", "H", 15, false), svc("b", "B", 20)];
    const withoutHidden = [svc("a", "A", 10), svc("b", "B", 20)];
    expect(sortVisibleServices(withHidden).map((s) => s.id)).toEqual(
      sortVisibleServices(withoutHidden).map((s) => s.id),
    );
  });
});

describe("applyServiceMove mirrors the migration-0161 RPC arithmetic", () => {
  const ids = ["a", "b", "c", "d"].map((id) => ({ id }));
  const run = (id: string, move: Parameters<typeof applyServiceMove>[2]) =>
    applyServiceMove(ids, id, move).map((s) => s.id);

  it("first → bottom", () => {
    expect(run("a", "bottom")).toEqual(["b", "c", "d", "a"]);
  });

  it("last → top", () => {
    expect(run("d", "top")).toEqual(["d", "a", "b", "c"]);
  });

  it("middle up moves exactly ONE position", () => {
    expect(run("c", "up")).toEqual(["a", "c", "b", "d"]);
  });

  it("middle down moves exactly ONE position", () => {
    expect(run("b", "down")).toEqual(["a", "c", "b", "d"]);
  });

  it("up at the top and down at the bottom are no-ops", () => {
    expect(run("a", "up")).toEqual(["a", "b", "c", "d"]);
    expect(run("d", "down")).toEqual(["a", "b", "c", "d"]);
    expect(run("a", "top")).toEqual(["a", "b", "c", "d"]);
    expect(run("d", "bottom")).toEqual(["a", "b", "c", "d"]);
  });

  it("an unknown id changes nothing", () => {
    expect(run("nope", "top")).toEqual(["a", "b", "c", "d"]);
  });

  it("a single-item list is stable under every move", () => {
    for (const move of ["top", "up", "down", "bottom"] as const) {
      expect(applyServiceMove([{ id: "only" }], "only", move).map((s) => s.id)).toEqual(["only"]);
    }
  });

  it("repeated 'up' walks a service to the top one step at a time", () => {
    // The behaviour Chloe expects and never got: Client Consultation reaches
    // position 1 in a bounded number of taps.
    let order = ["e1", "e2", "e3", "consult"].map((id) => ({ id }));
    for (let i = 0; i < 3; i += 1) order = applyServiceMove(order, "consult", "up");
    expect(order.map((s) => s.id)).toEqual(["consult", "e1", "e2", "e3"]);
  });

  it("'top' gets there in ONE tap", () => {
    const order = applyServiceMove(
      ["e1", "e2", "e3", "consult"].map((id) => ({ id })),
      "consult",
      "top",
    );
    expect(order.map((s) => s.id)[0]).toBe("consult");
  });

  it("does not mutate the input", () => {
    const input = ["a", "b"].map((id) => ({ id }));
    applyServiceMove(input, "b", "top");
    expect(input.map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("availableMoves gates the controls at the boundaries", () => {
  it("the first row cannot go up or to the top", () => {
    expect(availableMoves(0, 3)).toEqual({ top: false, up: false, down: true, bottom: true });
  });

  it("the last row cannot go down or to the bottom", () => {
    expect(availableMoves(2, 3)).toEqual({ top: true, up: true, down: false, bottom: false });
  });

  it("a middle row can do everything", () => {
    expect(availableMoves(1, 3)).toEqual({ top: true, up: true, down: true, bottom: true });
  });

  it("a lone service has no moves at all", () => {
    expect(availableMoves(0, 1)).toEqual({ top: false, up: false, down: false, bottom: false });
  });
});

describe("normalizedSortOrder matches the RPC's 10, 20, 30 …", () => {
  it("is 1-based × 10", () => {
    expect([0, 1, 2, 9].map(normalizedSortOrder)).toEqual([10, 20, 30, 100]);
  });

  it("produces strictly increasing, unique values", () => {
    const vals = Array.from({ length: 25 }, (_, i) => normalizedSortOrder(i));
    expect(new Set(vals).size).toBe(vals.length);
    expect([...vals].sort((a, b) => a - b)).toEqual(vals);
  });
});

describe("isServiceMove", () => {
  it("accepts exactly the four moves", () => {
    for (const m of ["top", "up", "down", "bottom"]) expect(isServiceMove(m)).toBe(true);
    for (const m of ["UP", "left", "", null, undefined, 1, {}]) expect(isServiceMove(m)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Source parity: every surface must use the SAME three-term ordering.
// ---------------------------------------------------------------------------
// The defect was a DISAGREEMENT between orderings, so the durable guard is that
// the settings page, the reorder action, the public booking query and migration
// 0161's RPC all resolve to (sort_order, name, id).
describe("every ordering surface uses the same canonical key", () => {
  const read = (rel: string) =>
    readFileSync(join(process.cwd(), rel), "utf8");

  it("the migration RPC orders by sort_order, name, id", () => {
    const sql = read("supabase/migrations/0161_service_order_and_colors.sql");
    expect(sql).toMatch(/order by sort_order asc, name asc, id asc/);
  });

  it("the public booking page adds the id tiebreak", () => {
    const page = read("app/book/[slug]/page.tsx");
    expect(page).toMatch(/\.order\("sort_order", \{ ascending: true \}\)\s*\n?\s*\.order\("name"\)\s*\n?\s*\.order\("id"\)/);
  });

  it("getAllServices no longer omits sort_order", () => {
    const queries = read("lib/booking/queries.ts");
    expect(queries).toMatch(/\.order\("sort_order", \{ ascending: true \}\)/);
  });

  it("the settings page sorts through the shared helper, not a local comparator", () => {
    const page = read("app/(app)/settings/services/page.tsx");
    expect(page).toMatch(/sortServicesForSettings\(services\)/);
    expect(page).not.toMatch(/a\.sort_order - b\.sort_order/);
  });

  it("the reorder action goes through the atomic RPC, not a two-step swap", () => {
    const actions = read("app/(app)/settings/services/actions.ts");
    expect(actions).toMatch(/rpc\("reorder_studio_service"/);
    expect(actions).toMatch(/p_expected_position/);
    // The old non-atomic swap is gone.
    expect(actions).not.toMatch(/neighbourSort - 1/);
    expect(actions).not.toMatch(/const \[newMine, newTheirs\]/);
  });

  it("re-showing a hidden service goes through the RPC that re-slots it", () => {
    const actions = read("app/(app)/settings/services/actions.ts");
    expect(actions).toMatch(/rpc\("show_studio_service"/);
  });

  it("the reorder controls are buttons with labels — no drag-only affordance", () => {
    const list = read("app/(app)/settings/services/ServiceOrderList.tsx");
    expect(list).toMatch(/type="button"/);
    expect(list).toMatch(/aria-label=/);
    expect(list).not.toMatch(/draggable|onDragStart|dnd-kit|react-beautiful-dnd/);
  });

  it("a move in flight disables every move control (single-flight)", () => {
    const list = read("app/(app)/settings/services/ServiceOrderList.tsx");
    expect(list).toMatch(/if \(pending\) return;/);
    expect(list).toMatch(/disabled=\{pending \|\| !moves\[direction\]\}/);
  });

  it("a refused move rolls the optimistic order back and shows why", () => {
    const list = read("app/(app)/settings/services/ServiceOrderList.tsx");
    expect(list).toMatch(/setOrder\(previous\); \/\/ rollback/);
    expect(list).toMatch(/role="alert"/);
  });
});
