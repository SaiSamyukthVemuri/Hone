import { PendingContainerLink } from "@/components/pending-link";

// HON-40 shell contract, slot `notifications` (owner: HON-106). Moved VERBATIM out of layout.tsx
// (step 0): same markup, accessible name, 99+ cap, test id and container form. Rendered twice, once per
// header container; any subscription or toast host belongs in NotificationsProvider, never here.
// PR #229: Notifications bell. A plain server-rendered link (no
// client JS): inline SVG bell + the same server-computed unread
// badge the old nav tab carried. The accessible name communicates
// the count ("Notifications, 3 unread").
export function NotificationsBell({ unread }: { unread: number }) {
  const label =
    unread > 0 ? `Notifications, ${unread} unread` : "Notifications";
  return (
    // THE CONTAINER FORM, and the only one of the seven that needs it.
    //
    // The other six anchors are LABELS — a word, which may fade to `opacity-0`
    // because its accessible name survives the fade. This one's content is a
    // LAYOUT: an icon plus a count badge positioned against the anchor itself.
    // `PendingLink` would wrap both in a single in-flow span (collapsing the
    // flex arrangement) and fade them, so the bell AND its unread count would
    // blank on press — a control going empty reads as a bug, not as an
    // acknowledgement. `PendingContainerLink` leaves both children exactly
    // where they were and dims them under an out-of-flow scrim instead.
    //
    // `relative` is NOT repeated here: the primitive owns that class precisely
    // so the scrim cannot escape to a distant positioned ancestor. The badge
    // below still resolves against this same anchor, unchanged.
    <PendingContainerLink
      href="/notifications"
      aria-label={label}
      data-testid="nav-notifications"
      pendingLabel="Opening Notifications…"
      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-900"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-5 w-5"
      >
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
      {unread > 0 && (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 inline-flex min-w-[18px] items-center justify-center rounded-full bg-rose-600 px-1 text-[11px] font-semibold leading-[18px] text-white"
        >
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </PendingContainerLink>
  );
}
