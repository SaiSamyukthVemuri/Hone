import { AccountMenu } from "./AccountMenu";
import { GlobalSearch } from "./GlobalSearch";
import { MobileMenu } from "./MobileMenu";
import { NotificationsBell } from "./NotificationsBell";

// HON-40 shell contract, step 0: the header's right-hand cluster, moved VERBATIM out of layout.tsx (same
// two containers, same classes, same order, same props). It renders TWO instances of each control, one per
// header mode, so nothing that must exist once per page (a key listener, a subscription, a toast host) may
// live inside a control: those belong in SearchProvider / NotificationsProvider, mounted once in layout.tsx.
// Slots, one owner each: search = GlobalSearch.tsx, notifications = NotificationsBell.tsx, account =
// AccountMenu.tsx + MobileMenu's account block. Changing ORDER, SPACING or the `lg` boundary is a
// shell-owner change.
export function HeaderCluster({
  unreadPersisted,
  computedUnread,
  displayName,
  studioName,
  role,
  admin,
  canSwitchStudio,
  showWaitlist,
}: {
  unreadPersisted: number;
  /** Computed, not persisted (overdue disinfectant alerts). Live updates must never drop it. */
  computedUnread: number;
  displayName: string;
  studioName: string;
  role: string;
  admin: boolean;
  canSwitchStudio: boolean;
  showWaitlist: boolean;
}) {
  return (
    <>
    {/* HEADER MODE, in one place. Exactly four classes choose
        between the full desktop shell and the compact one: this
        container, the primary nav above, the compact container
        below, and MobileMenu's own root. All four switch at `lg`
        so there is no width where both appear and none where
        neither does — 1023px is wholly compact, 1024px wholly
        desktop. The `md:px-8` on the row and on <main> is padding,
        not mode, and deliberately stays at md. */}
    <div className="hidden min-w-0 items-center gap-3 lg:flex">
      {/* PR #232: global search (clients, appointments, treatment
          memory, records, page shortcuts). Studio-scoped,
          authenticated-only; see global-search-actions.ts. */}
      <GlobalSearch variant="desktop" />
      <NotificationsBell unread={unreadPersisted + computedUnread} />
      {/* PR #231: account dropdown (Settings / Getting Started /
          Admin / Sign out + profile block) replaces the always-
          visible Sign out button and profile link. */}
      <AccountMenu
        displayName={displayName}
        studioName={studioName}
        role={role}
        admin={admin}
        canSwitchStudio={canSwitchStudio}
      />
    </div>

    {/* PR #229: mobile right side is bell + Menu. The menu is
        a small client component that closes itself on link
        taps (the no-JS details element from PR #228 stayed
        open across client-side navigations because this
        layout persists). */}
    <div className="flex items-center gap-1.5 lg:hidden">
      <GlobalSearch variant="mobile" />
      <NotificationsBell unread={unreadPersisted + computedUnread} />
      <MobileMenu
        admin={admin}
        displayName={displayName}
        studioName={studioName}
        role={role}
        canSwitchStudio={canSwitchStudio}
        showWaitlist={showWaitlist}
      />
    </div>
    </>
  );
}
