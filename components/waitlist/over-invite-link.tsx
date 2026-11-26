import { WAITLIST_OVER_INVITE_PATH } from "@/lib/waitlist/paths";
import { WaitlistNavLink } from "@/components/waitlist/waitlist-nav-link";

export const OVER_INVITE_LINK_PATH = WAITLIST_OVER_INVITE_PATH;
export const OVER_INVITE_LINK_LABEL = "Invite beyond the estimate";
export const OVER_INVITE_LINK_HELP = "Choose waiting clients to invite even when the week looks full. You confirm once; sending continues in the background.";

/**
 * The owner's way into the invite-beyond-the-estimate page. Rendered only for an owner: the caller passes the owner check the page already makes,
 * and a non-owner gets nothing at all (not a hidden element). The page behind the link makes its own owner check too.
 */
export function OverInviteLink({ isOwner }: { isOwner: boolean }) {
  if (isOwner !== true) return null;
  return (
    <section data-testid="over-invite-link" className="flex flex-col gap-1 text-sm">
      <WaitlistNavLink href={OVER_INVITE_LINK_PATH} className="min-h-11 self-start font-medium underline">
        {OVER_INVITE_LINK_LABEL}
      </WaitlistNavLink>
      <p className="text-neutral-600 dark:text-neutral-400">{OVER_INVITE_LINK_HELP}</p>
    </section>
  );
}
