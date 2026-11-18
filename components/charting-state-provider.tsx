"use client";

/**
 * Retained charting state: one place an editor's unsaved values can live so that a different
 * LAYOUT of the same session can mount the same editor and find the same values.
 *
 * What this is: a keyed holder of values, nothing else. It saves nothing, calls no server action,
 * submits no form, and knows nothing about records, appointments, messages or payments.
 *
 * Opt-in only. `useRetainedState(key, init)` behaves EXACTLY like `useState(init)` unless BOTH a
 * provider is mounted above it AND a key is given. Every existing caller passes no key, so nothing
 * changes until a view opts in. An opted-in editor discards its entry (`discard`) when the
 * practitioner cancels or the save succeeds, so retained values never outlive the edit they belong
 * to.
 */
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

type Box = { v: unknown };

export type RetainedStore = {
  get(key: string): Box | undefined;
  set(key: string, value: unknown): void;
  discard(key: string): void;
  subscribe(listener: () => void): () => void;
};

export function createRetainedStore(): RetainedStore {
  const map = new Map<string, Box>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of [...listeners]) l();
  };
  return {
    get: (key) => map.get(key),
    set(key, value) {
      // A NEW box per write so useSyncExternalStore sees a changed snapshot, even for an
      // equal-looking object.
      map.set(key, { v: value });
      emit();
    },
    discard(key) {
      if (map.delete(key)) emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const Ctx = createContext<RetainedStore | null>(null);

export function ChartingStateProvider({ children }: { children: ReactNode }) {
  const ref = useRef<RetainedStore | null>(null);
  if (ref.current === null) ref.current = createRetainedStore();
  return <Ctx.Provider value={ref.current}>{children}</Ctx.Provider>;
}

const noopSubscribe = () => () => undefined;

export function useRetainedState<T>(
  key: string | null | undefined,
  init: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const store = useContext(Ctx);
  const [local, setLocal] = useState<T>(init);
  const retained = store !== null && key != null;
  const box = useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    () => (retained ? store.get(key) : undefined),
    () => undefined,
  );
  const value = retained && box !== undefined ? (box.v as T) : local;
  // The setter's identity is stable per (store, key) and reads the CURRENT value, so a functional
  // update composes exactly as it does with useState.
  const valueRef = useRef(value);
  valueRef.current = value;
  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (u) => {
      const next = typeof u === "function" ? (u as (prev: T) => T)(valueRef.current) : u;
      valueRef.current = next;
      if (store !== null && key != null) store.set(key, next);
      else setLocal(next);
    },
    [store, key],
  );
  return [value, set];
}

/** Drop a retained entry: on cancel and after a successful save. A no-op without a provider. */
export function useDiscardRetained(): (key: string | null | undefined) => void {
  const store = useContext(Ctx);
  return useCallback(
    (key) => {
      if (store !== null && key != null) store.discard(key);
    },
    [store],
  );
}
