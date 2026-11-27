"use client";

import { Suspense, use, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";

// A <details> whose BODY is hydrated only when the person reaches for it (HON-109, Waitlist hydration reduction).
//
// THE PROBLEM, MEASURED
// ---------------------
// The Waitlist page renders ~66 rows, and each row carries its availability form, its text-consent form, its action forms, its remove form and an
// invite composer, every one a client component with server-action references, all inside a CLOSED <details>. The browser had to hydrate all of them
// before the page answered a press: 385 interactive elements, and a cold press waited 128-144 ms (Chromium) and 248-298 ms (WebKit) for any cue.
//
// WHAT THIS DOES
// --------------
// The server renders the body exactly as before, so the markup, the no-script behaviour and every form (a native multipart POST to its server action)
// are unchanged. On the client the body sits inside a Suspense boundary whose first child suspends until the row is "reached" (pointer over it, focus
// on its summary, a toggle, or already open). A boundary that suspends during hydration is LEFT DEHYDRATED: React keeps the server HTML, hydrates
// nothing under it, and hydrates it only when the gate opens, or earlier if the person presses something inside it (React hydrates the boundary and
// replays the event). Nothing is hidden: the content is never replaced by a fallback.
//
// WHAT IT DOES NOT DO
// -------------------
// It does not change what is rendered, requested, authorised or submitted, and it does not delay anything the person asked for. On the server the gate
// is a settled promise, so the server render never suspends.

type Gate = { open: () => void; promise: Promise<void> };

function openGate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { open, promise };
}

// A thenable `use()` reads synchronously: the server (and an already-reached row) must not suspend.
const SETTLED: Promise<void> = Object.assign(Promise.resolve(), { status: "fulfilled" as const, value: undefined });

function BodyGate({ promise }: { promise: Promise<void> }): null {
  use(promise);
  return null;
}

type Props = Omit<ComponentProps<"details">, "children" | "open"> & {
  summary: ReactNode;
  children: ReactNode;
};

export function LazyDetails({ summary, children, onToggle, onFocus, onPointerEnter, ...rest }: Props) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [gate] = useState<Gate | null>(() => (typeof window === "undefined" ? null : openGate()));
  const [reached, setReached] = useState(false);
  const reach = () => {
    if (!reached) setReached(true);
    gate?.open();
  };
  // A row restored already open (back/forward, find-in-page) is reached from the start.
  useEffect(() => {
    if (ref.current?.open) {
      setReached(true);
      gate?.open();
    }
  }, [gate]);

  return (
    <details
      {...rest}
      ref={ref}
      onToggle={(e) => { reach(); onToggle?.(e); }}
      onFocus={(e) => { reach(); onFocus?.(e); }}
      onPointerEnter={(e) => { reach(); onPointerEnter?.(e); }}
    >
      {summary}
      <Suspense fallback={null}>
        <BodyGate promise={gate === null || reached ? SETTLED : gate.promise} />
        {children}
      </Suspense>
    </details>
  );
}
