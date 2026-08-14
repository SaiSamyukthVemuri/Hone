import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/admin";
import {
  getRecentAdminActionEvents,
  type AdminActionEventRow,
} from "@/lib/audit/admin-actions";
import { FormattedDateTime } from "@/components/formatted-date-time";

// PR: admin action audit log (migration 0113). Read-only operator view of the
// most recent admin/operator actions (admin_action_events). Admin-only:
// app/admin/layout.tsx redirects non-admins before this renders, and this page
// re-checks isAdmin (defense-in-depth) before reading anything. Reads use the
// service-role client via getRecentAdminActionEvents (the table denies all
// authenticated access by design). Everything shown is safe by construction:
// the metadata was allowlisted + redacted at write time (no tokens, secrets,
// card data, URLs, or clinical/intake content), and actor_email is the operator's
// own internal address.

export const dynamic = "force-dynamic";

function outcomeClass(outcome: string): string {
  if (outcome === "succeeded") return "text-green-600 dark:text-green-400";
  if (outcome === "failed" || outcome === "blocked")
    return "text-red-600 dark:text-red-400";
  return "text-neutral-500";
}

// The metadata is already sanitized (primitives only, sensitive keys dropped),
// so a compact key:value summary is safe, no raw JSON blob.
function metaSummary(metadata: AdminActionEventRow["metadata"]): string {
  const parts = Object.entries(metadata ?? {})
    .filter(([, v]) => v != null && typeof v !== "object")
    .map(([k, v]) => `${k}: ${String(v)}`);
  return parts.length ? parts.join(" · ") : "—";
}

export default async function AdminAuditPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isAdmin(user.email)) {
    redirect("/no-access");
  }

  const events = await getRecentAdminActionEvents(50);

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-4 p-6">
      <div>
        <h1 className="text-lg font-semibold">Admin action audit</h1>
        <p className="mt-1 text-sm text-neutral-500">
          The {events.length} most recent operator actions (append-only). Records
          who did what, to which studio/resource, when, and the outcome. Safe
          metadata only, no tokens, secrets, card data, URLs, or clinical/intake
          content.
        </p>
      </div>

      {events.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No admin action events recorded yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500 dark:border-neutral-800">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Actor</th>
                <th className="px-3 py-2">Action</th>
                <th className="px-3 py-2">Outcome</th>
                <th className="px-3 py-2">Studio</th>
                <th className="px-3 py-2">Target</th>
                <th className="px-3 py-2">Detail</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr
                  key={e.id}
                  className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
                >
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-neutral-500">
                    <FormattedDateTime iso={e.createdAt} />
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {e.actorEmail ?? e.actorUserId ?? "—"}
                  </td>
                  <td className="px-3 py-2">{e.action}</td>
                  <td className={`px-3 py-2 font-medium ${outcomeClass(e.outcome)}`}>
                    {e.outcome}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-neutral-500">
                    {e.studioId ? `${e.studioId.slice(0, 8)}…` : "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-neutral-500">
                    {e.targetType}
                    {e.targetId ? `:${e.targetId.slice(0, 8)}…` : ""}
                  </td>
                  <td className="px-3 py-2 text-xs text-neutral-500">
                    {metaSummary(e.metadata)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
