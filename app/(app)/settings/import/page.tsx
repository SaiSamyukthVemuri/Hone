import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { templateText } from "@/lib/import/quick-import";
import { QuickImport } from "./QuickImport";

// PR #257: Quick Import V1. Owner-only (defense-in-depth over the settings nav
// only showing this tab to owners, and the server actions re-checking owner).
// The (app) shell already blocks anonymous + no-studio users.

export const metadata = {
  title: "Quick import · Settings",
};

export default async function ImportPage() {
  const { practitioner } = await getCurrentPractitionerWithStudio();

  if (practitioner.role !== "owner") {
    return (
      <section className="rounded-lg border border-neutral-200 p-5 text-sm text-neutral-600 dark:border-neutral-800 dark:text-neutral-400">
        Only studio owners can import clients and treatment history.
      </section>
    );
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight">Quick import</h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Bring over clients and basic treatment history from paper cards,
          spreadsheets, or exports.
        </p>
      </header>

      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
        <p>
          Paste from Google Sheets, Excel, Jane, Fresha, or a CSV/TSV file. Hone
          shows a preview before anything is imported.
        </p>
        <p>
          Moving from paper cards? Add one row per client or treatment area —
          Hone groups rows for the same client before import.
        </p>
        <p>
          This creates new clients and imported treatment-memory records. It does
          not overwrite existing records or treat imported history as live
          charting.
        </p>
      </div>

      <QuickImport template={templateText()} />
    </div>
  );
}
