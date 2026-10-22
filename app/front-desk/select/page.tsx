import { redirect } from "next/navigation";
import { listOwnFrontDeskStudios } from "@/lib/receptionist/identity";
import { selectFrontDeskStudioAction } from "./actions";
import { signOutFromGate } from "@/app/(auth)/no-access/actions";

// STUDIO-READY-02d (#824): the receptionist's studio chooser. It sits outside
// the guarded (desk) group, because that group's guard redirects HERE when a
// choice is needed. It lists only the caller's own active receptionist
// memberships.
export const dynamic = "force-dynamic";

export const metadata = { title: "Choose a studio", robots: { index: false, follow: false } };

export default async function FrontDeskSelectPage() {
  const studios = await listOwnFrontDeskStudios();
  if (studios.length === 0) redirect("/no-access");

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-4 py-10">
      <div>
        <h1 className="text-xl font-medium">Choose a studio</h1>
        <p className="mt-1 text-sm text-neutral-500">You work the front desk at more than one studio.</p>
      </div>
      <ul className="flex flex-col gap-2">
        {studios.map((s) => (
          <li key={s.studioId}>
            <form action={selectFrontDeskStudioAction}>
              <input type="hidden" name="studio_id" value={s.studioId} />
              <button
                type="submit"
                className="w-full rounded-md border border-neutral-300 px-4 py-2 text-left text-sm hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                {s.studioName}
              </button>
            </form>
          </li>
        ))}
      </ul>
      <form action={signOutFromGate}>
        <button type="submit" className="text-sm text-neutral-500 hover:underline">
          Sign out
        </button>
      </form>
    </main>
  );
}
