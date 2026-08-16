import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

// A REAL REACT HOST FOR HOOK TESTS.
//
// WHY THIS FILE EXISTS
// --------------------
// The first internal-booking foundation shipped 48 tests for its reducer and
// its pure semantics and ZERO for the hook, and two of the three P1 defects the
// review then found were in the hook -- both of them in the interaction between
// effect dependencies, dispatch and re-render. No amount of reducer testing
// could have caught either, and a source-grep test would have asserted only
// that some text was present.
//
// So the hook is exercised by actually mounting it in React, with real effects,
// real re-renders and real cleanup ordering. The repository's other React tests
// use `react-dom/server`, which never runs effects at all and therefore cannot
// express any of these cases.
//
// Deliberately small: React's own `act` plus `react-dom/client`. No testing
// library, and no fake reconciler -- a hand-rolled imitation of React's effect
// semantics would be asserting my model of the bug rather than the bug.

// React requires this before `act` may be used.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export type HookHandle<P, R> = {
  /** The most recent value the hook returned. */
  readonly current: R;
  /** Re-render with new props, flushing effects. */
  rerender: (props: P) => void;
  unmount: () => void;
};

export function renderHook<P, R>(
  hook: (props: P) => R,
  initialProps: P,
): HookHandle<P, R> {
  let latest: R;
  function Probe({ p }: { p: P }) {
    latest = hook(p);
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (p: P) => {
    act(() => {
      root.render(createElement(Probe, { p }));
    });
  };
  render(initialProps);
  return {
    get current() {
      return latest;
    },
    rerender: render,
    unmount: () => {
      act(() => {
        root.unmount();
      });
    },
  };
}

/**
 * Runs `fn` and flushes everything React has queued, including the
 * continuations of promises resolved inside it.
 */
export async function flush(fn: () => void = () => {}): Promise<void> {
  await act(async () => {
    fn();
  });
}

/** A promise whose settlement the test controls, so no timing is guessed. */
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
