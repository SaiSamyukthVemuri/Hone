import Link from "next/link";
import { MobileMenu } from "./MobileMenu";
import { AccountMenu } from "./AccountMenu";
import { GlobalSearch } from "./GlobalSearch";
import { createClient } from "@/lib/supabase/server";
import {
  listActiveStudioMemberships,
  requirePractitionerWithStudio,
} from "@/lib/supabase/queries";
import { isAdmin } from "@/lib/admin";
import { todayInTz } from "@/lib/booking/tz";
import { loadOverdueDisinfectantAlerts } from "@/lib/notifications/disinfectant-alerts";
import { AppFooter } from "@/app/_components/AppFooter";
import { SafeAnalytics } from "@/app/_components/SafeAnalytics";
import { identifyServerUser } from "@/lib/analytics/server";
import { timed } from "@/lib/observability/perf-timing";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Invite-only route guard (PR #253). Anonymous -> /login; authenticated
  // but no studio membership -> the safe /no-access gate. No-studio users
  // never render the app shell, nav, or any studio data.
  //
  // Measurement only (perf/route-timing-baseline): the `timed()` wrapper
  // returns exactly what the call returns and re-throws exactly what it
  // throws, so the /login and /no-access redirects below are unaffected —
  // they surface in telemetry as an `outcome: "threw"` span, which is the
  // expected shape for an unauthenticated request, not an error.
  const { practitioner, studio } = await timed("shell.identity", () =>
    requirePractitionerWithStudio(),
  );
  const admin = isAdmin(practitioner.email);

  // Identify the practitioner SERVER-SIDE (opaque UUID + validated coarse role
  // only). Moved off the browser: the authenticated app sends no browser
  // events, so client identify is neither needed nor safe. Post-response,
  // bounded, never blocks render (P1-ANALYTICS-01/-02).
  identifyServerUser({ id: practitioner.id, role: practitioner.role });

  // Show the "Switch studio" affordance only when the user is an active
  // practitioner in 2+ studios. RLS-scoped; a single-studio user sees nothing new.
  // Measured separately from shell.identity because the audit's open question
  // is whether this SECOND resolution of the same practitioner is material.
  const canSwitchStudio =
    (await timed("shell.memberships", () => listActiveStudioMemberships()))
      .length > 1;

  // PR #164. Unread notification count for the header badge. RLS
  // gates the count by studio membership; a failed count (network,
  // table missing in a hypothetical staging env) silently falls
  // back to zero so the layout never breaks. Single bounded query.
  //
  // Willow follow-up: overdue disinfectant "Replace now" records also count
  // toward the badge (computed, not persisted) so the operational safety alert is
  // visible from every page. Two bounded studio-scoped reads, run together.
  const [unreadPersisted, overdueDisinfectantCount] = await timed(
    "shell.support-reads",
    () =>
      Promise.all([
        loadUnreadNotificationCount(studio.id),
        loadOverdueDisinfectantCount(studio.id, studio.timezone),
      ]),
  );
  const unreadNotifications = unreadPersisted + overdueDisinfectantCount;

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
            {/* PR #228: the full horizontal nav is DESKTOP-ONLY. On
                phones the whitespace-nowrap row was wider than the
                viewport and dragged the whole page sideways; smaller
                screens use the compact menu below instead.

                THE MODE BOUNDARY IS `lg` (1024px), NOT `md`, and this
                class is one of the four that decide it — see the
                header-mode note above the compact controls below.
                MEASURED: at md the row of five primary items plus
                search/bell/account needs 830px with an ordinary owner
                name and 913px with one that fills the account button's
                12ch cap, so 768-1023 overflowed the page by up to
                145px. At 1024 both fit with room to spare. */}
            {/* Two <nav> landmarks exist in this shell (this row and the
                Menu sheet), so each carries its own accessible name. The
                mobile one has always been labelled; naming this one makes the
                pair distinguishable to a screen reader — and lets a test bind
                to "the primary navigation" rather than to a DOM position. */}
            <nav
              aria-label="Primary navigation"
              className="hidden items-center gap-0.5 whitespace-nowrap text-sm lg:flex lg:gap-1"
            >
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
              {/* OWNER-CAP follow-up: a PERMANENT owner entry point.
                  Labelled "Business", not "Capacity": capacity is the
                  first owner operating surface, not the whole domain,
                  so financials and the rest of the owner business
                  intelligence can land behind this same word without
                  renaming the tab under owners who learned it.

                  IT NOW POINTS AT /business. It used to go straight to
                  /dashboard/capacity, which was right while capacity was
                  the ONLY owner surface: a hub standing in front of one
                  destination is a click that buys nothing. Financials
                  makes it two, so the word has somewhere of its own to
                  mean, and Demand and Trends can land behind the same
                  tab without moving it again.

                  FINANCIALS DOES NOT GET A SIXTH TOP-LEVEL TAB. The
                  primary nav is the working surfaces; reporting is one
                  owner domain, not two entries competing for the same
                  header width.

                  OWNER-ONLY PRESENTATION, and only that. The role comes
                  from the practitioner this layout ALREADY resolved — no
                  second lookup, no extra query. Hiding the tab protects
                  nothing: /business, /dashboard/capacity and /financials
                  each keep their own server-side owner check, which is
                  the authority, and a practitioner typing any of the
                  routes still meets it. This just stops advertising a
                  surface they cannot use, rather than offering a
                  disabled item or a permission placeholder. */}
              {practitioner.role === "owner" && (
                <Link
                  href="/business"
                  className="rounded-md px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-900"
                >
                  Business
                </Link>
              )}
              {/* PR #231: Settings and Admin moved into the account
                  dropdown; the primary nav is the working surfaces. */}
            </nav>
          </div>
          {/* HEADER MODE, in one place. Exactly four classes choose
              between the full desktop shell and the compact one: this
              container, the primary nav above, the compact container
              below, and MobileMenu's own root. All four switch at `lg`
              so there is no width where both appear and none where
              neither does — 1023px is wholly compact, 1024px wholly
              desktop. The `md:px-8` on the row and on <main> is padding,
              not mode, and deliberately stays at md. */}
          <div className="hidden items-center gap-3 lg:flex">
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
            <NotificationsBell unread={unreadNotifications} />
            <MobileMenu
              admin={admin}
              displayName={practitioner.display_name}
              studioName={studio.name}
              role={practitioner.role}
              canSwitchStudio={canSwitchStudio}
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

// Willow follow-up: count of overdue disinfectant "Replace now" records for the
// badge. Computed from the same read-time source of truth as the Records page +
// Notification Centre (one bounded, studio-scoped, RLS-gated read). Never throws
// a failure falls back to zero so the header never breaks.
async function loadOverdueDisinfectantCount(
  studioId: string,
  timezone: string,
): Promise<number> {
  try {
    const supabase = await createClient();
    const alerts = await loadOverdueDisinfectantAlerts(
      supabase,
      studioId,
      todayInTz(timezone),
    );
    return alerts.length;
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
