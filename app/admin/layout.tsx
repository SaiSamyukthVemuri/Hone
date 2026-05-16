import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/admin";
import { signOut } from "../(app)/dashboard/actions";

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
          <div className="flex items-center gap-4 text-xs">
            <Link
              href="/admin"
              className="text-neutral-200 hover:text-white"
            >
              Overview
            </Link>
            <Link
              href="/dashboard"
              className="text-neutral-200 hover:text-white"
            >
              Exit to app
            </Link>
            <form action={signOut}>
              <button
                type="submit"
                className="text-neutral-200 hover:text-white"
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
    </div>
  );
}
