import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/admin";
import { SafeAnalytics } from "@/app/_components/SafeAnalytics";
import { signOut } from "../(app)/dashboard/actions";
import { CONTROL_MIN_TOUCH, NAV_ROW_FEEDBACK_ON_DARK, cx } from "@/components/ui/control-base";

// One class string for all six header controls (five links and the sign-out button): a 44px touch row with the shared dark-bar hover, pressed and focus steps.
const ADMIN_NAV_ROW = cx(CONTROL_MIN_TOUCH, "rounded-sm px-2 text-neutral-200", NAV_ROW_FEEDBACK_ON_DARK);

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!isAdmin(user.email)) redirect("/dashboard");

  return (
    <div className="min-h-screen bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <div className="bg-neutral-900 text-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-2 md:px-8">
          <div className="flex items-center gap-3 text-xs uppercase tracking-[0.18em]">
            <span className="rounded-sm bg-white px-2 py-0.5 font-bold text-neutral-900">
              Admin
            </span>
            <span className="text-neutral-300">{user.email}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1 text-xs" data-testid="admin-nav">
            <Link
              href="/admin"
              className={ADMIN_NAV_ROW}
            >
              Overview
            </Link>
            <Link
              href="/admin/studios/new"
              className={ADMIN_NAV_ROW}
            >
              New studio
            </Link>
            <Link
              href="/admin/rollouts"
              className={ADMIN_NAV_ROW}
            >
              Rollouts
            </Link>
            <Link
              href="/admin/ops-alerts"
              className={ADMIN_NAV_ROW}
            >
              Ops alerts
            </Link>
            <Link
              href="/dashboard"
              className={ADMIN_NAV_ROW}
            >
              Exit to app
            </Link>
            <form action={signOut}>
              <button
                type="submit"
                className={ADMIN_NAV_ROW}
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </div>
      <main className="mx-auto max-w-6xl px-5 py-8 md:px-8 md:py-10">
        {children}
      </main>
      {/* PR #142. Safe tree (no token descendants). */}
      <SafeAnalytics />
    </div>
  );
}
