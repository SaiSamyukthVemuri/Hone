import Link from "next/link";
import { MobileMenu } from "./MobileMenu";
import { AccountMenu } from "./AccountMenu";
import { GlobalSearch } from "./GlobalSearch";
import { createClient } from "@/lib/supabase/server";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { isAdmin } from "@/lib/admin";
import { AppFooter } from "@/app/_components/AppFooter";
import { SafeAnalytics } from "@/app/_components/SafeAnalytics";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Invite-only route guard (PR #253). Anonymous -> /login; authenticated
  // but no studio membership -> the safe /no-access gate. No-studio users
  // never render the app shell, nav, or any studio data.
  const { practitioner, studio } = await requirePractitionerWithStudio();
  const admin = isAdmin(practitioner.email);

  // PR #164. Unread notification count for the header badge. RLS
  // gates the count by studio membership; a failed count (network,
  // table missing in a hypothetical staging env) silently falls
  // back to zero so the layout never breaks. Single bounded query.
  const unreadNotifications = await loadUnreadNotificationCount(studio.id);

  return (
    <div className="min-h-screen bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      {/* z-20 + fully opaque background. The previous bg-white/90 +
          backdrop-blur let dark content (the weekly-hours card on the
          availability page) bleed through the header as it scrolled
          under, which read as "the dark box is on top of the menu".
          Solid background plus a higher z-index than every in-page
          element (calendar slot z-10, TimePicker dropdown z-20, etc.)
          guarantees the header sits visually above everything. */}
      <header className="sticky top-0 z-30 border-b border-neutral-200 bg-white print:hidden dark:border-neutral-800 dark:bg-neutral-950">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 md:px-8">
          <div className="flex items-center gap-6">
            {/* PR #230: the wordmark is a Dashboard link again,
                reversing the earlier deliberate-non-interactive
                decision. Context changed: the old conflict was with a
                nav tab labeled "Today" (since renamed "Dashboard"),
                and on phones the wordmark is the only always-visible
                way home now that the tab row lives inside the Menu. */}
            <Link
              href="/dashboard"
              aria-label="Go to Dashboard"
              className="select-none text-xl font-semibold tracking-tight"
            >
              Hone
            </Link>
            {/* PR #228: the full horizontal nav is DESKTOP/TABLET
                only. On phones the whitespace-nowrap row was wider
                than the viewport and dragged the whole page sideways;
                small screens use the compact menu below instead. */}
            <nav className="hidden items-center gap-0.5 whitespace-nowrap text-sm md:flex md:gap-1">
              {/* PR #208: the landing page is the practice Dashboard
                  (it contains the Today section). */}
              <Link
                href="/dashboard"
                className="rounded-md px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-900"
              >
                Dashboard
              </Link>
              <Link
                href="/clients"
                className="rounded-md px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-900"
              >
                Clients
              </Link>
              <Link
                href="/calendar"
                className="rounded-md px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-900"
              >
                Calendar
              </Link>
              {/* PR #229: Notifications moved out of the main tab
                  row to the header bell (right side, both
                  breakpoints), so the primary nav competes less and
                  fits phones better. */}
              {/* PR #205: health-inspection record keeping. A
                  top-level operational logbook, deliberately NOT
                  under Settings (Chloe's ask). PR #209: nav label
                  shortened to "Records" so the header fits without
                  wrapping; the page heading stays "Record Keeping". */}
              <Link
                href="/records"
                className="rounded-md px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-900"
              >
                Records
              </Link>
              {/* PR #231: Settings and Admin moved into the account
                  dropdown; the primary nav is the four working
                  surfaces. */}
            </nav>
          </div>
          <div className="hidden items-center gap-3 md:flex">
            {/* PR #232: global search (clients, appointments, treatment
                memory, records, page shortcuts). Studio-scoped,
                authenticated-only; see global-search-actions.ts. */}
            <GlobalSearch variant="desktop" />
            <NotificationsBell unread={unreadNotifications} />
            {/* PR #231: account dropdown (Settings / Getting Started /
                Admin / Sign out + profile block) replaces the always-
                visible Sign out button and profile link. */}
            <AccountMenu
              displayName={practitioner.display_name}
              studioName={studio.name}
              role={practitioner.role}
              admin={admin}
            />
          </div>

          {/* PR #229: mobile right side is bell + Menu. The menu is
              a small client component that closes itself on link
              taps (the no-JS details element from PR #228 stayed
              open across client-side navigations because this
              layout persists). */}
          <div className="flex items-center gap-1.5 md:hidden">
            <GlobalSearch variant="mobile" />
            <NotificationsBell unread={unreadNotifications} />
            <MobileMenu
              admin={admin}
              displayName={practitioner.display_name}
              studioName={studio.name}
              role={practitioner.role}
            />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-5 py-8 md:px-8 md:py-10">
        {children}
      </main>
      <AppFooter />
      {/* PR #142. Analytics mounts here (and at the other safe-tree
          layouts + marketing leaf pages) instead of the root layout,
          so token-bearing public routes never inherit it. */}
      <SafeAnalytics />
    </div>
  );
}

// PR #164. Header unread-notification badge count. RLS scopes
// the query to the authenticated practitioner's studio. The
// partial unread index from migration 0070 backs this read; the
// query is bounded and safe to run on every authenticated page
// render. A failure (network, missing table in a fresh env)
// falls back to zero so the layout never breaks.
async function loadUnreadNotificationCount(studioId: string): Promise<number> {
  try {
    const supabase = await createClient();
    const { count, error } = await supabase
      .from("practitioner_notifications")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", studioId)
      .is("read_at", null);
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

// PR #229: Notifications bell. A plain server-rendered link (no
// client JS): inline SVG bell + the same server-computed unread
// badge the old nav tab carried. The accessible name communicates
// the count ("Notifications, 3 unread").
function NotificationsBell({ unread }: { unread: number }) {
  const label =
    unread > 0 ? `Notifications, ${unread} unread` : "Notifications";
  return (
    <Link
      href="/notifications"
      aria-label={label}
      className="relative flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-900"
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
    </Link>
  );
}
