import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { templateText } from "@/lib/import/quick-import";
import {
  isImportOperator,
  IMPORT_SUPPORT_MAILTO,
} from "@/lib/import/operator-assist";
import { QuickImport } from "./QuickImport";

// PR #257: Quick Import V1. Owner-only (defense-in-depth over the settings nav
// only showing this tab to owners, and the server actions re-checking owner).
// The (app) shell already blocks anonymous + no-studio users.
//
// IMPORT-01 (mitigation): the route stays, as an INFORMATIONAL surface. An
// ordinary owner sees what to prepare and how to reach Hone; the executable
// paste-and-confirm island renders only for a platform operator. This page is
// the courtesy, not the control: both server actions refuse a non-operator
// before their first write (see ./actions.ts and lib/import/operator-assist).

export const metadata = {
  title: "Import clients and history · Settings",
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

  const operator = await isImportOperator();

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <header>
        <h2 className="text-2xl font-semibold tracking-tight">
          Import clients and history
        </h2>
        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
          Bring over clients and basic treatment history from paper cards,
          spreadsheets, or exports.
        </p>
      </header>

      {operator ? <OperatorImport /> : <OperatorAssistedNotice />}
    </div>
  );
}

// What an ordinary studio owner sees. Every claim here is one the server will
// actually honour: they cannot run the import, Hone runs it for them, and the
// template is the shape to send over.
function OperatorAssistedNotice() {
  return (
    <>
      <section className="flex flex-col gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
        <h3 className="text-base font-medium">
          Import is currently operator-assisted
        </h3>
        <p>
          Hone runs studio migrations for you. Self-service import is turned
          off while we rebuild it: a run that failed part-way could leave
          clients created with none of their history, and trying again would
          skip those same clients instead of repairing them.
        </p>
        <p>
          Nothing about your existing records changes, and nothing has been
          imported that you cannot see.
        </p>
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
        <h3 className="text-base font-medium">Get your records brought over</h3>
        <p>
          Email us with roughly how many clients you have and what you are
          coming from: paper cards, Google Sheets, Excel, Jane, Fresha, or a
          CSV export. We will do the migration with you and confirm the counts
          before and after.
        </p>
        <div>
          <a
            href={IMPORT_SUPPORT_MAILTO}
            className="inline-block rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            Contact support
          </a>
        </div>
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-4 text-sm text-neutral-700 dark:border-neutral-800 dark:text-neutral-300">
        <h3 className="text-base font-medium">What to have ready</h3>
        <p>
          One row per client, or one row per treatment area if you are coming
          from paper cards: we group rows for the same client. This is the
          column shape that needs the least back and forth:
        </p>
        <pre className="overflow-x-auto rounded-md border border-neutral-200 bg-neutral-50 p-3 font-mono text-xs text-neutral-800 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200">
          {templateText()}
        </pre>
        <p className="text-xs text-neutral-500">
          Imported history is recorded as imported memory. It is never treated
          as live charting in Hone, and it never overwrites an existing record.
        </p>
      </section>
    </>
  );
}

// Operator-only. The unchanged PR #257 flow, behind a banner that says plainly
// which surface this is, so an operator running a migration is never in doubt
// about whose authority they are using.
function OperatorImport() {
  return (
    <>
      <div className="rounded-lg border border-neutral-900 bg-neutral-900 px-4 py-3 text-sm text-white dark:border-white dark:bg-white dark:text-neutral-900">
        Operator-assisted import. Self-service import is disabled for studio
        owners until the staged rebuild ships; you are seeing this because you
        are a Hone operator.
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
        <p>
          Paste from Google Sheets, Excel, Jane, Fresha, or a CSV/TSV file. Hone
          shows a preview before anything is imported.
        </p>
        <p>
          Moving from paper cards? Add one row per client or treatment area,
          Hone groups rows for the same client before import.
        </p>
        <p>
          This creates new clients and imported treatment-memory records. It does
          not overwrite existing records or treat imported history as live
          charting. A failure part-way through leaves the created clients in
          place: check the summary counts before telling the studio it is done.
        </p>
      </div>

      <QuickImport template={templateText()} />
    </>
  );
}
