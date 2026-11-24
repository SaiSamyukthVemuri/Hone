"use client";

import { createContext, useContext, useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import {
  applyServiceMove,
  availableMoves,
  type ServiceMove,
} from "@/lib/booking/service-order";
import { Button } from "@/components/ui/button";
import type { ServiceColorKey } from "@/lib/calendar/service-colors";
import { ServiceColorDot } from "./ServiceFormControls";
import { moveServiceAction } from "./actions";

export type OrderRow = {
  id: string;
  name: string;
  active: boolean;
  duration: number;
  price: string;
  colorKey: ServiceColorKey | null;
  editor: React.ReactNode;
  visibility: React.ReactNode;
};

type MenuGroup = { label: string; ids: string[] };
const CREATE = "new";
// onSaved: the server accepted a save. setSaving: a save is in flight for that service, so its "Discard edits" must stay disabled until the request settles
// (a discard would remount the form while the original save is still running; that save's onSaved would then erase a newer draft and close the mobile editor).
const SavedServiceContext = createContext<{ onSaved: (id: string) => void; setSaving: (id: string, saving: boolean) => void }>({ onSaved: () => {}, setSaving: () => {} });

export function ServiceSaveForm({ serviceId = CREATE, title, saveAction, children }: {
  serviceId?: string;
  title: string;
  saveAction: (data: FormData) => Promise<void>;
  children: React.ReactNode;
}) {
  const { onSaved, setSaving } = useContext(SavedServiceContext);
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const creating = serviceId === CREATE;
  return (
    <form
      aria-label={creating ? "New service" : `Edit ${title}`}
      action={saveAction}
      className="@container/editor"
      aria-busy={pending}
      onSubmitCapture={async (event) => {
        // Keep the dirty guard's baseline until the server accepts the save.
        event.preventDefault();
        event.stopPropagation();
        if (submitting.current) return;
        const data = new FormData(event.currentTarget);
        submitting.current = true;
        setPending(true);
        setSaving(serviceId, true);
        setFailed(false);
        try {
          await saveAction(data);
          onSaved(serviceId);
        } catch {
          setFailed(true);
        } finally {
          submitting.current = false;
          setPending(false);
          setSaving(serviceId, false);
        }
      }}
    >
      <fieldset disabled={pending} className="min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4">
          <div className="min-w-0 flex-1 basis-32">
            <p className="text-xs text-fg-muted">{creating ? "Booking menu" : "Edit service"}</p>
            <h3 tabIndex={-1} data-service-title className="scroll-mt-24 text-lg font-semibold leading-tight tracking-tight [overflow-wrap:anywhere]">{title}</h3>
          </div>
          <Button type="submit" variant="primary" pending={pending} busyLabel={creating ? "Adding…" : "Saving…"}>
            {creating ? "Add service" : "Save changes"}
          </Button>
        </div>
        {failed && <p role="alert" className="px-4 pt-3 text-sm text-danger-solid">Couldn’t save this service. Your edits are still here. Try again.</p>}
        {children}
      </fieldset>
    </form>
  );
}


const MOVE_LABELS: Record<ServiceMove, { label: string; glyph: string }> = {
  top: { label: "Move to top", glyph: "⤒" },
  up: { label: "Move up", glyph: "↑" },
  down: { label: "Move down", glyph: "↓" },
  bottom: { label: "Move to bottom", glyph: "⤓" },
};

export function ServiceOrderList({ rows, groups, createEditor }: {
  rows: ReadonlyArray<OrderRow>;
  groups: MenuGroup[];
  createEditor: React.ReactNode;
}) {
  const first = groups[0]?.ids[0] ?? rows[0]?.id ?? CREATE;
  const [selected, setSelected] = useState(first);
  const [mobileEditor, setMobileEditor] = useState<string | null>(null);
  const [reordering, setReordering] = useState(false);
  // Keep visited forms mounted while switching services so a pending edit
  // survives both the mobile Back control and the desktop master list.
  const [visited, setVisited] = useState(() => new Set([first]));
  const [formKeys, setFormKeys] = useState<Record<string, number>>({});
  const [savingIds, setSavingIds] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState("");
  useEffect(() => {
    function followOrderLink() {
      if (window.location.hash === "#service-order") {
        setReordering(true);
        setMobileEditor(null);
      }
    }
    followOrderLink();
    window.addEventListener("hashchange", followOrderLink);
    return () => window.removeEventListener("hashchange", followOrderLink);
  }, []);

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
  // would never be adopted: the list would keep showing a stale order until a
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

  const current = selected === CREATE || byId.has(selected) ? selected : first;
  const hiddenIds = ordered.filter((row) => !row.active).map((row) => row.id);
  const menuGroups = reordering
    ? [{ label: "Booking order", ids: visibleIds }]
    : groups;
  const displayGroups = hiddenIds.length
    ? [...menuGroups, { label: "Hidden from booking", ids: hiddenIds }]
    : menuGroups;

  function selectService(id: string) {
    setSelected(id);
    setMobileEditor(id);
    setVisited((seen) => new Set([...seen, id]));
    setNotice("");
    requestAnimationFrame(() => {
      document.getElementById(`service-editor-${id}`)?.querySelector<HTMLElement>("[data-service-title]")?.focus();
    });
  }

  function focusMenu(id: string) {
    requestAnimationFrame(() => document.getElementById(`service-select-${id}`)?.focus());
  }

  function rowView(row: OrderRow) {
    const position = visibleIds.indexOf(row.id);
    const moves = availableMoves(position, visibleIds.length);
    return (
      <li key={row.id} data-testid={`service-row-${row.id}`} className="flex list-none flex-col gap-1.5">
        <button
          type="button"
          onClick={() => selectService(row.id)}
          id={`service-select-${row.id}`}
          aria-label={`Edit ${row.name}`}
          aria-pressed={current === row.id}
          aria-controls={`service-editor-${row.id}`}
          className="flex w-full min-w-0 cursor-pointer items-center justify-between gap-2 border-l-[3px] border-transparent px-3 py-3 text-left hover:bg-surface-sunken focus-visible:outline-offset-[-3px] aria-pressed:border-l-fg aria-pressed:bg-surface-sunken"
        >
          <span className="min-w-0">
            <span data-service-name className="block text-sm font-semibold [overflow-wrap:anywhere]">{row.name}</span>
            <span className="block text-xs text-fg-muted">{row.duration} min · {row.price}</span>
          </span>
          {row.colorKey && <span className="inline-flex shrink-0 items-center gap-1.5 text-xs capitalize">
            <ServiceColorDot colorKey={row.colorKey} />{row.colorKey}
          </span>}
        </button>
        {reordering && row.active && visibleIds.length > 1 && (
          <div className="flex flex-wrap items-center gap-1 px-3 pb-2">
            <span className="basis-full text-xs tabular-nums text-fg-muted">Visible in booking · Position {position + 1} of {visibleIds.length}</span>
            {(Object.keys(MOVE_LABELS) as ServiceMove[]).map((direction) => (
              <button
                key={direction}
                type="button"
                onClick={() => move(row.id, direction)}
                disabled={pending || !moves[direction]}
                aria-label={`${MOVE_LABELS[direction].label}: ${row.name}`}
                title={MOVE_LABELS[direction].label}
                data-testid={`move-${direction}-${row.id}`}
                className="h-11 w-11 cursor-pointer rounded-md border border-line-strong text-fg hover:bg-surface-sunken disabled:cursor-default disabled:opacity-40"
              >
                {MOVE_LABELS[direction].glyph}
              </button>
            ))}
          </div>
        )}
      </li>
    );
  }

  return (
    <div className="@container/services">
      <p role="status" className={notice ? "mb-3 text-sm font-medium" : "sr-only"}>{notice}</p>
      <div className="grid min-w-0 items-start gap-4 @[670px]/services:grid-cols-[clamp(235px,25%,400px)_minmax(0,1fr)]">
        <section
          id="service-order"
          className={`min-w-0 scroll-mt-24 overflow-hidden rounded-lg border border-line bg-surface ${mobileEditor ? "hidden @[670px]/services:block" : ""}`}
          aria-label="Service menu"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 p-4">
            <div>
              <h3 className="font-semibold tracking-tight">{reordering ? <span>Service menu order</span> : "Service menu"}</h3>
              <p className="text-xs text-fg-muted">{visibleIds.length} visible in booking</p>
            </div>
            <Button type="button" size="sm" id={`service-select-${CREATE}`} onClick={() => selectService(CREATE)}>+ Add service</Button>
          </div>
          {visibleIds.length > 1 && (
            <div className="border-t border-line px-3 py-1">
              <Button size="sm" variant="quiet" type="button" aria-pressed={reordering} onClick={() => setReordering(!reordering)}>
                {reordering ? "Done reordering" : "Reorder services"}
              </Button>
              {reordering && <p className="px-1 pb-2 text-xs text-fg-muted">The booking page groups services by modality and uses this order within each group.</p>}
            </div>
          )}
          {error && <p role="alert" data-testid="service-reorder-error" className="border-y border-line p-3 text-sm text-fg">{error}</p>}
          {rows.length === 0 && <p className="border-t border-line p-4 text-sm text-fg-muted">Add your first service to build your booking menu.</p>}
          {displayGroups.map((group, groupIndex) => (
            <div key={groupIndex}>
              <h4 className="border-y border-line bg-surface-sunken px-4 py-1.5 text-xs font-semibold text-fg-muted">{group.label}</h4>
              <ul className="divide-y divide-line">{group.ids.map((id) => {
                const row = byId.get(id);
                return row ? rowView(row) : null;
              })}</ul>
            </div>
          ))}
        </section>
        <SavedServiceContext.Provider value={{ setSaving: (id, on) => setSavingIds((ids) => (ids[id] === on || (!on && !ids[id]) ? ids : { ...ids, [id]: on })), onSaved: (id) => {
          const panel = document.getElementById(`service-editor-${id}`);
          const listHidden = !document.getElementById("service-order")?.getClientRects().length;
          const returnFocus = panel && !panel.hidden && listHidden;
          setFormKeys((keys) => ({ ...keys, [id]: (keys[id] ?? 0) + 1 }));
          setNotice(id === CREATE ? "Service added to your booking menu." : "Service changes saved.");
          setMobileEditor((open) => open === id ? null : open);
          if (returnFocus) focusMenu(id);
        } }}>
        <section
          aria-label="Service editor"
          className={`min-w-0 rounded-lg border border-line bg-surface ${mobileEditor ? "" : "hidden @[670px]/services:block"}`}
        >
          <div className="border-b border-line px-2 @[670px]/services:hidden">
            <Button size="sm" variant="quiet" type="button" onClick={() => { setMobileEditor(null); focusMenu(current); }}>← Services list</Button>
          </div>
          {[...rows.map((r) => r.id), CREATE].map((id) => {
            const row = byId.get(id);
            const isCurrent = current === id;
            return (
              <div id={`service-editor-${id}`} key={id} hidden={!isCurrent}>
                {(isCurrent || visited.has(id)) && (
                  <div key={formKeys[id] ?? 0}>
                    {row ? row.editor : createEditor}
                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
                      {row && <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-fg-muted">{row.active ? "Visible in booking" : "Hidden from booking"}</span>
                        {row.visibility}
                      </div>}
                      <Button size="sm" variant="quiet" type="button" disabled={savingIds[id] === true} aria-disabled={savingIds[id] === true} data-testid={`discard-edits-${id}`} title={savingIds[id] ? "Saving… wait for the save to finish" : undefined} onClick={() => {
                        if (savingIds[id]) return;
                        setFormKeys((keys) => ({ ...keys, [id]: (keys[id] ?? 0) + 1 }));
                        setMobileEditor(null);
                        setNotice("Edits discarded.");
                        focusMenu(id);
                      }}>Discard edits</Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </section>
        </SavedServiceContext.Provider>
      </div>
    </div>
  );
}
