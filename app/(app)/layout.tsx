import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { isAdmin } from "@/lib/admin";
import { AppFooter } from "@/app/_components/AppFooter";
import { SafeAnalytics } from "@/app/_components/SafeAnalytics";
import { signOut } from "./dashboard/actions";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
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
            {/* Brand wordmark is intentionally non-interactive in the
                authenticated app. Chloe flagged that a clickable "Hone"
                competed with "Today" as the dashboard link. "Today" is
                the dashboard link; this is a plain label (no href, no
                onClick, no pointer cursor). */}
            <span className="select-none text-xl font-semibold tracking-tight">
              Hone
            </span>
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
              {/* PR #164. Practitioner notification center. Badge
                  renders when unread count is positive; otherwise
                  the link reads as plain "Notifications". The
                  count itself lives on the server-rendered layout
                  so the badge is correct on initial page load
                  without client-side polling. */}
              <Link
                href="/notifications"
                className="relative rounded-md px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-900"
              >
                Notifications
                {unreadNotifications > 0 && (
                  <span
                    aria-label={`${unreadNotifications} unread`}
                    className="ml-1.5 inline-flex min-w-[18px] items-center justify-center rounded-full bg-rose-600 px-1.5 text-[11px] font-semibold text-white"
                  >
                    {unreadNotifications > 99 ? "99+" : unreadNotifications}
                  </span>
                )}
              </Link>
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
              <Link
                href="/settings/profile"
                className="rounded-md px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-900"
              >
                Settings
              </Link>
              {admin && (
                <Link
                  href="/admin"
                  className="rounded-md px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-900"
                >
                  Admin
                </Link>
              )}
            </nav>
          </div>
          <div className="hidden items-center gap-4 md:flex">
            <Link
              href="/settings/profile"
              aria-label="Open your profile settings"
              className="rounded-md text-right text-xs leading-tight hover:opacity-80"
            >
              <div className="font-medium">{practitioner.display_name}</div>
              <div className="text-neutral-500">{studio.name}</div>
            </Link>
            <form action={signOut}>
              <button
                type="submit"
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                Sign out
              </button>
            </form>
          </div>

          {/* PR #228 compact mobile menu (no JS: details/summary).
              Contains every main nav destination plus Sign out, so
              nothing is unreachable on a phone. The unread badge
              rides on the Menu button so notifications stay visible
              without the full nav row. */}
          <details className="relative md:hidden">
            <summary
              aria-label="Open navigation menu"
              className="flex min-h-[44px] cursor-pointer select-none list-none items-center gap-2 rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden dark:border-neutral-700"
            >
              Menu
              {unreadNotifications > 0 && (
                <span
                  aria-label={`${unreadNotifications} unread notifications`}
                  className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-rose-600 px-1.5 text-[11px] font-semibold text-white"
                >
                  {unreadNotifications > 99 ? "99+" : unreadNotifications}
                </span>
              )}
            </summary>
            <nav
              aria-label="Mobile navigation"
              className="absolute right-0 z-40 mt-2 flex w-60 flex-col gap-0.5 rounded-lg border border-neutral-200 bg-white p-2 text-sm shadow-lg dark:border-neutral-800 dark:bg-neutral-950"
            >
              {[
                { href: "/dashboard", label: "Dashboard" },
                { href: "/clients", label: "Clients" },
                { href: "/calendar", label: "Calendar" },
                { href: "/notifications", label: "Notifications" },
                { href: "/records", label: "Records" },
                { href: "/settings/profile", label: "Settings" },
                ...(admin ? [{ href: "/admin", label: "Admin" }] : []),
              ].map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex min-h-[44px] items-center justify-between rounded-md px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-900"
                >
                  {item.label}
                  {item.href === "/notifications" && unreadNotifications > 0 && (
                    <span className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-rose-600 px-1.5 text-[11px] font-semibold text-white">
                      {unreadNotifications > 99 ? "99+" : unreadNotifications}
                    </span>
                  )}
                </Link>
              ))}
              <div className="mt-1 border-t border-neutral-200 pt-2 dark:border-neutral-800">
                <p className="px-3 pb-1 text-xs text-neutral-500">
                  {practitioner.display_name} · {studio.name}
                </p>
                <form action={signOut}>
                  <button
                    type="submit"
                    className="flex min-h-[44px] w-full items-center rounded-md px-3 py-2 text-left hover:bg-neutral-100 dark:hover:bg-neutral-900"
                  >
                    Sign out
                  </button>
                </form>
              </div>
            </nav>
          </details>
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
