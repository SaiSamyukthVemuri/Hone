"use client";

// Service menu order — the interactive list (Chloe: "Move up / Move down feels
// strange; the service I want first cannot reliably reach the top").
//
// WHAT THIS COMPONENT OWNS
//   * The order the practitioner SEES, as local state, so a tap moves the row
//     under their finger immediately instead of after a server round-trip on a
//     phone connection.
//   * Rollback: if the server refuses the move (including the migration-0161
//     stale-position guard), the previous order is restored and the reason is
//     shown in place — no error boundary, no lost scroll position.
//   * A single-flight lock: while one move is in flight EVERY move control is
//     disabled, so interleaved taps can never start two read-modify-write
//     cycles against the same list.
//
// WHAT IT DOES NOT OWN
//   * Position arithmetic — that lives in lib/booking/service-order.ts and is
//     the same arithmetic migration 0161's RPC performs.
//   * Each row's expanded/collapsed state — that stays inside its own
//     ServiceAccordionItem, keyed by service id, so reordering rows preserves
//     which ones are open.
//
// ACCESSIBILITY. These are ordinary <button>s with real labels, reachable by
// keyboard and screen reader. There is deliberately NO drag-only affordance:
// a drag handle would be added only alongside these controls, never instead.

import { useOptimistic, useRef, useState, useTransition } from "react";
import {
  applyServiceMove,
  availableMoves,
  type ServiceMove,
} from "@/lib/booking/service-order";
import { moveServiceAction } from "./actions";

export type OrderRow = {
  id: string;
  // The service NAME, so the move controls have a meaningful accessible name.
  // A screen reader must not hear "Move up: 3f2b8c1a-9d4e-…".
  name: string;
  active: boolean;
  // Rendered header + edit form for this service, produced on the server.
  node: React.ReactNode;
};

const MOVE_LABELS: Record<ServiceMove, { label: string; glyph: string }> = {
  top: { label: "Move to top", glyph: "⤒" },
  up: { label: "Move up", glyph: "↑" },
  down: { label: "Move down", glyph: "↓" },
  bottom: { label: "Move to bottom", glyph: "⤓" },
};

export function ServiceOrderList({ rows }: { rows: ReadonlyArray<OrderRow> }) {
  // The server order is the source of truth; local state only leads it.
  const [order, setOrder] = useState<string[]>(() => rows.map((r) => r.id));
  const [optimisticOrder, setOptimisticOrder] = useOptimistic(order);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const serverOrderRef = useRef<string>(rows.map((r) => r.id).join(","));

  // Re-sync when the server sends a new order (after revalidate, or after
  // another surface changed the services).
  //
  // The ref advances ONLY when the sync is actually applied. Advancing it while
  // a move was in flight would mark that server order as "already seen" and it
  // would never be adopted — the list would keep showing a stale order until a
  // full page load.
  const incoming = rows.map((r) => r.id).join(",");
  if (incoming !== serverOrderRef.current && !pending) {
    serverOrderRef.current = incoming;
    setOrder(rows.map((r) => r.id));
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = optimisticOrder.map((id) => byId.get(id)).filter(Boolean) as OrderRow[];
  const visibleIds = ordered.filter((r) => r.active).map((r) => r.id);

  function move(id: string, direction: ServiceMove) {
    if (pending) return; // single-flight: one move at a time
    const position = visibleIds.indexOf(id);
    if (position === -1) return;
    const previous = order;
    const nextVisible = applyServiceMove(
      visibleIds.map((v) => ({ id: v })),
      id,
      direction,
    ).map((v) => v.id);
    if (nextVisible.join(",") === visibleIds.join(",")) return; // no-op at the end
    // Hidden rows keep their trailing block; only the visible order changes.
    const hidden = order.filter((v) => !visibleIds.includes(v));
    const next = [...nextVisible, ...hidden];

    setError(null);
    startTransition(async () => {
      setOptimisticOrder(next);
      const result = await moveServiceAction({
        id,
        move: direction,
        expectedPosition: position,
      });
      if (result.ok) {
        // Adopt the order the DATABASE produced, not the optimistic guess. The
        // RPC declines the move when the caller's view was stale (the service
        // was hidden or removed elsewhere) and returns what it actually wrote.
        const authoritative = result.order.filter((v) => byId.has(v));
        const hiddenTail = previous.filter((v) => !authoritative.includes(v));
        setOrder(authoritative.length > 0 ? [...authoritative, ...hiddenTail] : next);
      } else {
        setOrder(previous); // rollback
        setError(result.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p
          role="alert"
          data-testid="service-reorder-error"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        >
          {error}
        </p>
      )}
      {/* Roomier gap so cards read as separate objects rather than one slab. */}
      <ul className="flex list-none flex-col gap-4 p-0">
        {ordered.map((row) => {
          const position = visibleIds.indexOf(row.id);
          const moves = availableMoves(position, visibleIds.length);
          return (
            // A real layout box, NOT display:contents — an element with no box
            // is "not being rendered" per spec, which drops list semantics for
            // assistive tech and gives the row a zero bounding rect.
            <li
              key={row.id}
              data-testid={`service-row-${row.id}`}
              className="flex list-none flex-col gap-1.5"
            >
              {row.node}
              {row.active && visibleIds.length > 1 && (
                <div className="flex flex-wrap items-center gap-1.5 px-1">
                  {/* The position as a NUMBER — the single source of truth for
                      "where am I in the order", and never conveyed by colour or
                      arrow placement alone. */}
                  <span className="text-[11px] tabular-nums text-neutral-500">
                    Position {position + 1} of {visibleIds.length}
                  </span>
                  {(Object.keys(MOVE_LABELS) as ServiceMove[]).map((direction) => (
                    <button
                      key={direction}
                      type="button"
                      onClick={() => move(row.id, direction)}
                      disabled={pending || !moves[direction]}
                      aria-label={`${MOVE_LABELS[direction].label}: ${row.name}`}
                      title={MOVE_LABELS[direction].label}
                      data-testid={`move-${direction}-${row.id}`}
                      className="min-h-[36px] min-w-[36px] rounded-md border border-neutral-300 px-2.5 text-sm leading-none text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900"
                    >
                      {MOVE_LABELS[direction].glyph}
                    </button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
