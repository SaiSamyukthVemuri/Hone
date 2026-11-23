import { requireReceptionistChoice } from "@/lib/desk/guard";
import { chooseDeskStudioAction } from "@/lib/desk/choose-actions";

// Which studio's front desk to open, for a receptionist who is on the books of two or more studios. It lists only the
// user's ACTIVE receptionist studios and carries no client data. A receptionist cannot read a studio's name (no read
// is granted on the studios table), so each studio is labelled by its position in the list plus the display name that
// studio gave this person. Dynamic, private and never stored. It sits outside the desk layout on purpose: that layout
// resolves a studio, and this is the page a person with no selected studio is sent to.
//
// The guard is called here, not assumed from a layout (tests/desk/desk-source-contract.test.ts pins it).

export const dynamic = "force-dynamic";
export const metadata = { title: "Choose a studio", robots: { index: false, follow: false } };

export default async function DeskChoosePage() {
  const rows = await requireReceptionistChoice();
  return (
    <main className="mx-auto max-w-md px-4 py-10 text-neutral-900 dark:text-neutral-100">
      <h1 className="text-lg font-semibold">Choose a studio</h1>
      <p className="mt-1 text-sm text-neutral-500">You work at more than one studio. Pick the front desk to open.</p>
      <ul className="mt-6 space-y-3">
        {rows.map((r, i) => (
          <li key={r.id}>
            <form action={chooseDeskStudioAction}>
              <input type="hidden" name="studio_id" value={r.studio_id} />
              <button type="submit" className="flex min-h-11 w-full items-center justify-between rounded-md border border-neutral-300 px-4 py-3 text-left dark:border-neutral-700">
                <span>Studio {i + 1}</span>
                <span className="text-sm text-neutral-500">{r.display_name}</span>
              </button>
            </form>
          </li>
        ))}
      </ul>
    </main>
  );
}
