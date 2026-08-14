import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AcceptForm } from "./AcceptForm";

export const metadata: Metadata = {
  title: "Accept invitation: Hone",
  robots: { index: false, follow: false },
};

// Explicit-acceptance page for an existing Hone account invited to a new studio
// when no reusable current-version acceptance evidence exists. Authenticated but
// OUTSIDE the practitioner-gated (app) shell (middleware exempts it from the
// no-studio gate), so a user with a pending invite and no membership can reach
// it. Shows ONLY safe self-scoped invite info (studio name + role); the caller
// cannot enter the app until they confirm the current policies here.
export default async function AcceptInvitationPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: rec } = await supabase.rpc("my_pending_invitation");
  const info = (rec && typeof rec === "object" ? rec : {}) as {
    status?: string;
    studio_name?: string;
    role?: string;
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <div className="rounded-lg border border-neutral-200 p-6 dark:border-neutral-800">
        <h1 className="font-[var(--font-fraunces)] text-2xl font-bold tracking-tight text-neutral-900 dark:text-neutral-50">
          Join your studio
        </h1>

        {info.status === "ok" && info.studio_name ? (
          <>
            <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
              You&rsquo;ve been invited to{" "}
              <strong className="text-neutral-900 dark:text-neutral-100">
                {info.studio_name}
              </strong>{" "}
              as {info.role ?? "practitioner"}. Review the current Terms and
              Privacy Policy, then confirm to join.
            </p>
            <AcceptForm
              studioName={info.studio_name}
              role={info.role ?? "practitioner"}
            />
          </>
        ) : info.status === "ambiguous" ? (
          <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
            There is more than one pending invitation for your account. Please
            contact the studio or support so it can be resolved.
          </p>
        ) : (
          <>
            <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
              There is no pending invitation for your account right now.
            </p>
            <a
              href="/dashboard"
              className="mt-4 inline-block text-sm underline decoration-neutral-300 underline-offset-2 hover:text-neutral-900 dark:hover:text-neutral-100"
            >
              Go to your dashboard
            </a>
          </>
        )}
      </div>
    </main>
  );
}
