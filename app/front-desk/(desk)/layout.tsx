import Link from "next/link";
import { requireReceptionistWithStudio } from "@/lib/receptionist/identity";
import { signOutFromGate } from "@/app/(auth)/no-access/actions";

// STUDIO-READY-02d (#824): the receptionist's own shell. It is outside app/(app)
// on purpose: that shell's guard is requirePractitionerWithStudio, and a
// receptionist must never render it. Each page re-runs the guard itself,
// because a layout's redirect does not stop its page (Next renders them in
// parallel).
export const dynamic = "force-dynamic";

export const metadata = { title: "Front desk", robots: { index: false, follow: false } };

export default async function FrontDeskLayout({ children }: { children: React.ReactNode }) {
  const { receptionist, studio } = await requireReceptionistWithStudio();
  return (
    <div className="min-h-screen bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="border-b border-neutral-200 dark:border-neutral-800">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{studio.name}</div>
            <div className="text-xs text-neutral-500">Front desk · {receptionist.displayName}</div>
          </div>
          <nav className="flex items-center gap-4 text-sm" aria-label="Front desk">
            <Link href="/front-desk" className="hover:underline">
              Schedule
            </Link>
            <Link href="/front-desk/book" className="hover:underline">
              Book
            </Link>
            <Link href="/front-desk/contacts" className="hover:underline">
              Contacts
            </Link>
            <form action={signOutFromGate}>
              <button type="submit" className="text-neutral-500 hover:underline">
                Sign out
              </button>
            </form>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
    </div>
  );
}
