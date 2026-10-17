"use client";

import { cx } from "@/components/ui/control-base";
import { useInviteOutcomePending } from "@/components/waitlist/invite-outcome-boundary";

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
    <a {...rest} href={href} data-waitlist-nav="true" data-pending="false" className={className}>
      {children}
    </a>
  );
}
