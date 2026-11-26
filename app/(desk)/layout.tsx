import type { ReactNode } from "react";
import Link from "next/link";
import { requireReceptionistWithStudio } from "@/lib/desk/guard";
import { signOutFromGate } from "@/app/(auth)/no-access/actions";

// The receptionist desk shell. It is NOT the practitioner shell: it never renders app/(app)/layout.tsx, so no
// practitioner navigation, notification count, dashboard read or financial link can appear, and it runs none of that
// layout's user-identification or analytics hooks. It mounts no analytics and sends no client data to any analytics
// call. Every link stays under /desk and none is prefetched.
//
// Dynamic, private and never stored: nothing here is statically generated or shared-cached.
//
// A layout's redirect does not stop its page from rendering, so the guard is ALSO called by every page. The flag
// (default off) is checked inside the guard: flag off is a 404.

export const dynamic = "force-dynamic";
export const metadata = { title: "Front desk", robots: { index: false, follow: false } };

export default async function DeskLayout({ children }: { children: ReactNode }) {
  const identity = await requireReceptionistWithStudio();
  return (
    <div className="min-h-screen bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="border-b border-neutral-200 dark:border-neutral-800">
        <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-5">
            <span className="text-base font-semibold">Front desk</span>
            <nav aria-label="Desk" className="flex gap-4 text-sm">
              <Link href="/desk" prefetch={false} className="inline-flex min-h-11 items-center hover:underline">
                Schedule
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-neutral-500">{identity.displayName}</span>
            <form action={signOutFromGate}>
              <button type="submit" className="inline-flex min-h-11 items-center rounded-md border border-neutral-300 px-3 dark:border-neutral-700">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-screen-2xl px-4 py-6">{children}</main>
    </div>
  );
}
