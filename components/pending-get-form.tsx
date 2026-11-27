"use client";

import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { createContext, useContext, useTransition, type ComponentProps, type FormEvent, type ReactNode } from "react";

import { spinnerClasses } from "@/components/ui/spinner";
import { cx } from "@/components/ui/control-base";

// A GET form that acknowledges its own submission (HON-109, Analytics and the Statements month picker).
//
// THE PROBLEM, MEASURED
// ---------------------
// A native `<form method="get">` is a full document navigation. The old page stays painted and inert until the NEW page's first paint, so the person
// gets no acknowledgement for the whole server read: 0.8 to 1.3 s median, every run over the 100 ms budget, on the Analytics period form, the
// Waitlist capacity form and every control built on one. `useFormStatus` cannot help: it only reports a form ACTION (a function), and a native GET
// form has none, so a PendingButton inside such a form never showed busy.
//
// WHAT THIS DOES
// --------------
// It keeps the form a real GET form (action + method stay, so it still works without script and the submitted names and values are exactly the ones
// the page's strict parser reads), and on submit it performs the same navigation through the client router inside a transition. The transition's
// pending flag is shared with the submit controls inside it through a context, so a control can show busy in the same frame as the press.
//
// WHAT IT DOES NOT DO
// -------------------
// It does not change what is requested: the URL is built from the form's own successful controls exactly as the browser would (`FormData`,
// urlencoded), so the request, the page and its access rules are unchanged. It does not delay anything and it adds no artificial wait.

const PendingGetFormContext = createContext(false);

/** True while the enclosing PendingGetForm's navigation is in flight. False outside one. */
export function usePendingGetForm(): boolean {
  return useContext(PendingGetFormContext);
}

type FormProps = Omit<ComponentProps<"form">, "action" | "method" | "onSubmit"> & { action: string; children: ReactNode };

export function PendingGetForm({ action, children, ...rest }: FormProps) {
  // Read the router from its context rather than useRouter(): outside a mounted app router (a server-render test, a static export) this is null and the
  // form simply stays a native GET form, where useRouter() would throw.
  const router = useContext(AppRouterContext);
  const [pending, start] = useTransition();

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    // Anything the browser would do differently (a submitter with its own formaction/target, a modified click) stays a native submit.
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | HTMLInputElement | null;
    if (submitter && (submitter.hasAttribute("formaction") || submitter.hasAttribute("formtarget") || submitter.hasAttribute("formmethod"))) return;
    if (!router) return;
    if (pending) {
      // A second press while the first navigation is in flight: do nothing (the control is also disabled while pending).
      event.preventDefault();
      return;
    }
    event.preventDefault();
    const data = new FormData(event.currentTarget, submitter);
    const query = new URLSearchParams();
    for (const [name, value] of data) if (typeof value === "string") query.append(name, value);
    const qs = query.toString();
    start(() => {
      router.push(qs ? `${action}?${qs}` : action);
    });
  }

  return (
    <PendingGetFormContext.Provider value={pending}>
      <form {...rest} action={action} method="get" onSubmit={onSubmit} aria-busy={pending || undefined}>
        {children}
      </form>
    </PendingGetFormContext.Provider>
  );
}

/**
 * The submit control for a PendingGetForm whose look the call site already owns (a `className` string). While the form's navigation is in flight it is
 * disabled (the duplicate-submit guard), says `aria-busy`, and shows the app's one spinner mark in place of nothing: the label stays, the mark is added
 * beside it out of flow so the control never changes width. The live region says what is happening for a screen reader.
 */
export function PendingSubmit({ children, className, pendingLabel = "Loading…" }: { children: ReactNode; className?: string; pendingLabel?: string }) {
  const pending = usePendingGetForm();
  return (
    <button type="submit" disabled={pending} aria-busy={pending || undefined} data-pending={pending ? "true" : undefined} className={cx("relative", className)}>
      <span className={pending ? "opacity-0" : undefined}>{children}</span>
      {pending ? <span data-pending-mark="true" aria-hidden="true" className={cx("pointer-events-none absolute inset-0 m-auto", spinnerClasses("sm"))} /> : null}
      <span role="status" className="sr-only">{pending ? pendingLabel : ""}</span>
    </button>
  );
}
