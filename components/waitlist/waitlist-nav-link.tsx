"use client";

import { useEffect, useState, type MouseEvent } from "react";

import { cx } from "@/components/ui/control-base";
import { spinnerClasses } from "@/components/ui/spinner";
import { useInviteOutcomePending } from "@/components/waitlist/invite-pending-context";

/**
 * A queue-navigation control that cannot strand an in-flight invitation.
 *
 * WHY THIS EXISTS. The submission result has exactly ONE observer — the
 * boundary's `useActionState` — and by design nothing persists it. A full
 * navigation mid-flight therefore destroys the answer before the practitioner
 * reads it, and an invitation that already committed has already consumed the
 * round's allowance. So while a send is pending, every control that would
 * leave or recreate this page stops being a link.
 *
 * IT STOPS BEING A LINK, RATHER THAN LOOKING DISABLED. There is no `href` at
 * all while pending, so neither a click nor a keyboard activation can follow
 * it, and it leaves the tab order. An `aria-disabled` label over a live `href`
 * would still navigate for a keyboard user, and `pointer-events: none` would
 * still navigate for everyone not using a mouse — both are the same bug wearing
 * different clothes.
 *
 * The reason is announced, not merely implied: assistive tech gets the disabled
 * state and the explanation, not a control that silently does nothing.
 *
 * CALLER ATTRIBUTES ARE FORWARDED. Each control already carries its own
 * `data-testid`; an earlier version of this primitive hardcoded one and silently
 * clobbered them, which broke the queue's existing navigation assertions. This
 * adds `data-waitlist-nav` alongside rather than replacing anything.
 *
 * ACKNOWLEDGES THE PRESS (HON-109). The link stays a plain anchor (a full document navigation, as before: the queue page is rebuilt from the
 * server and nothing here may soft-navigate over an in-flight send). A plain anchor gives no sign of life until the NEW page paints, 0.5 s on the
 * measured baseline, so a plain left click also sets a local flag that paints the app's one spinner over the control and says so to a screen
 * reader. It starts nothing, delays nothing and changes no request; it is cleared if the page is restored from the back/forward cache.
 */
export function WaitlistNavLink({
  href,
  className,
  children,
  ...rest
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLElement>) {
  const pending = useInviteOutcomePending();
  const [going, setGoing] = useState(false);
  useEffect(() => {
    const restored = (e: PageTransitionEvent) => { if (e.persisted) setGoing(false); };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, []);
  const { onClick, ...anchorRest } = rest;
  const handleClick = (event: MouseEvent<HTMLElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    setGoing(true);
  };

  if (pending) {
    return (
      <span
        {...rest}
        aria-disabled="true"
        data-waitlist-nav="true"
        data-pending="true"
        title="Waiting for the invitation result"
        className={cx(className, "cursor-default opacity-50")}
      >
        {children}
        <span className="sr-only"> (unavailable while an invitation is sending)</span>
      </span>
    );
  }

  return (
    <a {...anchorRest} onClick={handleClick} href={href} data-waitlist-nav="true" data-pending="false" aria-busy={going || undefined} className={cx("relative", className)}>
      {children}
      {going ? (
        <span data-link-pending="true" aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[inherit] bg-white/60 dark:bg-neutral-950/60">
          <span className={spinnerClasses("sm")} />
        </span>
      ) : null}
      <span role="status" className="sr-only">{going ? "Opening…" : ""}</span>
    </a>
  );
}
