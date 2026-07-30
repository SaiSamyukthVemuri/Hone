// THE canonical service ordering (Chloe: "the service I want first cannot
// reliably reach the top").
//
// WHY THIS MODULE EXISTS. Before this, three places ordered services three
// different ways:
//   * lib/booking/queries.ts       — `order by active desc, name` (no sort_order!)
//   * settings/services/page.tsx   — re-sorted in JS by (active, sort_order, name)
//   * settings/services/actions.ts — `order by sort_order` with NO secondary key
// `services.sort_order` is `not null default 100` with no uniqueness and a
// PER-MODALITY allocator, so ties are the NORMAL state. A tie under
// `order by sort_order` alone comes back in HEAP order, which changes after
// every UPDATE — so the row the reorder action found at index N was routinely
// not the row the practitioner saw at screen position N. When the action
// happened to find the clicked service at index 0 it silently did nothing, and
// because a no-op changes nothing the next tap resolved the tie identically.
// The arrow was permanently dead for that row.
//
// The fix is a TOTAL order shared by every surface. The trailing `id` term is
// what makes it total: with it there is no tie left for the database to resolve
// arbitrarily, so the screen, the server action and the migration-0161 RPC can
// never disagree.
//
// This file is pure and client-safe. It must stay byte-compatible with the
// ORDER BY inside `public.reorder_studio_service` (migration 0161):
//     order by sort_order asc, name asc, id asc

export type OrderableService = {
  id: string;
  name: string;
  sort_order: number;
  active: boolean;
};

// Compare two services within the SAME visibility bucket.
export function compareServicePosition<T extends OrderableService>(a: T, b: T): number {
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
  // `localeCompare` on the client vs Postgres collation on the server can
  // disagree, so both sides sort in JS from the same data. The action re-sorts
  // the rows it read rather than trusting an ORDER BY.
  const byName = a.name.localeCompare(b.name);
  if (byName !== 0) return byName;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// The SETTINGS list order: hidden services sink to the bottom, everything else
// by canonical position. Hidden rows are kept inline (not in a separate
// section) so Hide/Show flips a pill in place instead of relocating the card.
export function sortServicesForSettings<T extends OrderableService>(
  services: ReadonlyArray<T>,
): T[] {
  return [...services].sort(
    (a, b) => Number(b.active) - Number(a.active) || compareServicePosition(a, b),
  );
}

// The VISIBLE (bookable) order — the one the public booking page, the internal
// quick-book drawer and the client-profile picker must all resolve to.
export function sortVisibleServices<T extends OrderableService>(
  services: ReadonlyArray<T>,
): T[] {
  return services.filter((s) => s.active).sort(compareServicePosition);
}

export type ServiceMove = "top" | "up" | "down" | "bottom";

export const SERVICE_MOVES: ReadonlyArray<ServiceMove> = ["top", "up", "down", "bottom"];

export function isServiceMove(value: unknown): value is ServiceMove {
  return typeof value === "string" && (SERVICE_MOVES as readonly string[]).includes(value);
}

// Pure preview of a move — the SAME arithmetic migration 0161's RPC performs.
// Used for optimistic UI (so the row moves under the practitioner's finger) and
// unit-tested against the RPC's behaviour. Returns the input unchanged when the
// move is a no-op (already at the requested end).
export function applyServiceMove<T extends { id: string }>(
  ordered: ReadonlyArray<T>,
  serviceId: string,
  move: ServiceMove,
): T[] {
  const list = [...ordered];
  const idx = list.findIndex((s) => s.id === serviceId);
  if (idx === -1) return list;
  const target =
    move === "top"
      ? 0
      : move === "bottom"
        ? list.length - 1
        : move === "up"
          ? Math.max(0, idx - 1)
          : Math.min(list.length - 1, idx + 1);
  if (target === idx) return list;
  const [moved] = list.splice(idx, 1);
  list.splice(target, 0, moved);
  return list;
}

// Which move controls are meaningful for a row at `position` in a list of
// `total` visible services. A single-item list has none.
export function availableMoves(position: number, total: number): Record<ServiceMove, boolean> {
  const canUp = position > 0;
  const canDown = position >= 0 && position < total - 1;
  return { top: canUp, up: canUp, down: canDown, bottom: canDown };
}

// The normalized positions the RPC writes: 10, 20, 30 … Exported so tests can
// assert the app and the database agree on the sequence.
export function normalizedSortOrder(position: number): number {
  return (position + 1) * 10;
}
