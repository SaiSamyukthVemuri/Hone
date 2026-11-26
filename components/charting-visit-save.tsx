"use client";

/**
 * SAVE VISIT: one control that SAVES EACH SECTION BY CALLING THAT SECTION'S OWN SAVE, one after another, and shows each section's own result.
 *
 * It is an orchestrator, never a second save path. A section registers `saver`, which is the same function its own Save button runs (same
 * validation, same retry key, same pending/hold states). Save visit adds no write of its own.
 *
 *  - NOT ATOMIC. Sections are saved in turn; one can succeed while another fails. Each result is shown separately, and a failure never hides
 *    or stops the others.
 *  - HOLDS WIN. A section that is mid-save, or holds an unresolved outcome (a lost answer, a recovery lock), reports "held" and is not called.
 *  - ONE RUN AT A TIME. A second click while a run is in progress does nothing (an in-flight flag here, not only a disabled button).
 *  - FIXED ORDER: top to bottom on the page. Savers are looked up by id when their turn comes, because a saved form closes itself.
 *  - It never finishes the appointment, sends postcare, charges anything or changes the view.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";

export type SaveOutcome =
  | { status: "saved" }
  /** Nothing unsaved, so no call was made. */
  | { status: "nothing" }
  /** Not attempted: the section is mid-save or holds an unresolved outcome. */
  | { status: "held"; message: string }
  /** The answer was LOST (a thrown error, a dropped reply): a save may or may not have happened. Never retried by Save visit. */
  | { status: "unknown" }
  | { status: "failed"; message: string };

export type SectionSaver = () => Promise<SaveOutcome>;
export type SectionResult = { id: string; label: string; outcome: SaveOutcome };

type Entry = { label: string; el: RefObject<HTMLElement | null>; saver: RefObject<SectionSaver> };
type Api = {
  register: (id: string, e: Entry) => () => void;
  saveVisit: () => Promise<void>;
  running: boolean;
  results: SectionResult[] | null;
  /** True when at least one section can be saved from here. */
  hasSections: boolean;
};
const Ctx = createContext<Api | null>(null);

export function ChartingVisitSaveProvider({ children }: { children: ReactNode }) {
  const entries = useRef(new Map<string, Entry>());
  const runningRef = useRef(false);
  const alive = useRef(true);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<SectionResult[] | null>(null);
  const [count, setCount] = useState(0);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  const register = useCallback((id: string, e: Entry) => {
    entries.current.set(id, e);
    setCount(entries.current.size);
    return () => {
      // Only remove OUR entry: a remount under the same id may already have replaced it.
      if (entries.current.get(id) === e) entries.current.delete(id);
      setCount(entries.current.size);
    };
  }, []);
  const saveVisit = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setResults([]);
    // Snapshot the ORDER at click time; each saver is looked up again at its turn.
    const order = [...entries.current.entries()]
      .sort(([, a], [, b]) => {
        const x = a.el.current;
        const y = b.el.current;
        if (!x || !y) return 0;
        return x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      })
      .map(([id, e]) => ({ id, label: e.label }));
    const done: SectionResult[] = [];
    try {
      for (const { id, label } of order) {
        const live = entries.current.get(id);
        let outcome: SaveOutcome;
        if (!live) outcome = { status: "nothing" };
        else {
          try {
            outcome = await live.saver.current();
          } catch {
            // A saver that THROWS gave no answer: a save may have happened. Unknown, never "did not save".
            outcome = { status: "unknown" };
          }
        }
        done.push({ id, label, outcome });
        if (alive.current) setResults([...done]);
      }
    } finally {
      runningRef.current = false;
      if (alive.current) setRunning(false);
    }
  }, []);
  const api = useMemo(() => ({ register, saveVisit, running, results, hasSections: count > 0 }), [register, saveVisit, running, results, count]);
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

/** A section registers its OWN save. No-op without a provider (Current view, any bare form). */
export function useRegisterVisitSaver(id: string, label: string, el: RefObject<HTMLElement | null>, saver: SectionSaver) {
  const api = useContext(Ctx);
  const register = api?.register;
  const saverRef = useRef(saver);
  useEffect(() => {
    saverRef.current = saver;
  });
  useEffect(() => {
    if (!register) return;
    return register(id, { label, el, saver: saverRef });
  }, [register, id, label, el]);
}

export function useVisitSave() {
  return useContext(Ctx);
}

const STATUS_TEXT: Record<SaveOutcome["status"], string> = {
  saved: "Saved",
  nothing: "Nothing entered",
  held: "Not saved",
  failed: "Not saved",
  unknown: "Result unknown — check the section",
};

/** The Save visit control and each section's own result. Never contains what the practitioner typed, or any message text: labels and phrases are fixed. */
export function VisitSaveControl() {
  const api = useContext(Ctx);
  if (!api || !api.hasSections) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="visit-save">
      <button
        type="button"
        onClick={() => void api.saveVisit()}
        disabled={api.running}
        data-testid="visit-save-button"
        className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
      >
        {api.running ? "Saving…" : "Save visit"}
      </button>
      <p className="text-xs text-neutral-500">Saves each section below in turn and shows each result. It does not finish the appointment.</p>
      {api.results && api.results.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs" data-testid="visit-save-results" role="status">
          {api.results.map((r) => (
            <li key={r.id} data-testid={`visit-save-result-${r.id}`} data-status={r.outcome.status}>
              <span className="font-medium">{r.label}:</span> {STATUS_TEXT[r.outcome.status]}
              {/* FIXED PHRASES ONLY. A section's own message can name what was typed (an area, a value) or come from a thrown error, so the
                  detail stays on that section, where the form already shows it. */}
              {r.outcome.status === "held" || r.outcome.status === "failed" ? " — see the message on that section." : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
