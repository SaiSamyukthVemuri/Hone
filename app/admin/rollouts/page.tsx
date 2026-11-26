import { redirect } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/auth/require-platform-admin";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { CHARTING_ROLLOUT_KEY } from "@/lib/rollouts/charting-rollout";
import { ALL_CONFIRM_PHRASE } from "@/lib/rollouts/admin-commands";
import { addPilotStudioAction, removePilotStudioAction, setRolloutModeAction, type RolloutActionResult } from "./actions";

// Operator control for the xCell MultiPlex and New view rollout. Admin-only: the layout redirects non-admins, this page re-checks, and every
// action re-checks again. It shows studio NAMES only (never an id, owner email, client or machine data); an id travels only in a form's hidden
// value. Turning it on creates nothing in any studio: it changes only what the existing code offers.

export const dynamic = "force-dynamic";

type Row = { mode: string; updated_by: string | null; updated_at: string | null; studio_id: string | null; studio_name: string | null; added_by: string | null; added_at: string | null };

async function operatorLabel(admin: ReturnType<typeof createAdminClient>, id: string | null): Promise<string> {
  if (!id) return "unknown";
  try {
    const { data } = await admin.auth.admin.getUserById(id);
    const meta = (data?.user?.user_metadata ?? {}) as Record<string, unknown>;
    const name = typeof meta.full_name === "string" && meta.full_name.trim() ? meta.full_name.trim() : null;
    return name ?? data?.user?.email ?? "unknown";
  } catch {
    return "unknown";
  }
}

export default async function RolloutsPage({ searchParams }: { searchParams: Promise<{ notice?: string; ok?: string }> }) {
  await requirePlatformAdmin();
  const sp = await searchParams;
  const admin = createAdminClient();
  const read = await admin.rpc("list_platform_rollout", { p_key: CHARTING_ROLLOUT_KEY });
  const rows = (read.error || !Array.isArray(read.data) ? null : (read.data as Row[])) ;
  const mode = rows?.[0]?.mode ?? null;
  const pilots = (rows ?? []).filter((r) => r.studio_id);
  const lastBy = rows ? await operatorLabel(admin, rows[0]?.updated_by ?? null) : null;
  const addedBy = new Map<string, string>();
  for (const id of new Set(pilots.map((p) => p.added_by).filter((x): x is string => !!x))) addedBy.set(id, await operatorLabel(admin, id));
  // The picker: names only, studios not already in the pilot.
  const { data: studios } = await admin.from("studios").select("id, name").order("name", { ascending: true }).limit(500);
  const inPilot = new Set(pilots.map((p) => p.studio_id));
  const choices = ((studios ?? []) as { id: string; name: string }[]).filter((s) => !inPilot.has(s.id));

  async function finish(result: RolloutActionResult): Promise<never> {
    "use server";
    redirect(`/admin/rollouts?ok=${result.ok ? "1" : "0"}&notice=${encodeURIComponent(result.message)}`);
  }
  async function setMode(fd: FormData) { "use server"; await finish(await setRolloutModeAction(fd)); }
  async function add(fd: FormData) { "use server"; await finish(await addPilotStudioAction(fd)); }
  async function remove(fd: FormData) { "use server"; await finish(await removePilotStudioAction(fd)); }

  return (
    <main className="mx-auto max-w-3xl px-5 py-8 md:px-8">
      <h1 className="text-2xl font-semibold">xCell MultiPlex and New view rollout</h1>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
        Off: nobody sees it. Pilot: only the studios listed below. All: every studio. This changes what the app offers; it never creates a machine, block or reading in any studio. Existing saved MultiPlex blocks stay readable in every mode.
      </p>
      {sp.notice ? <p role="status" className={`mt-4 rounded border px-3 py-2 text-sm ${sp.ok === "1" ? "border-green-600" : "border-red-600"}`}>{sp.notice.slice(0, 200)}</p> : null}
      {rows === null ? (
        <p role="alert" className="mt-6 rounded border border-red-600 px-3 py-2 text-sm">The current setting could not be read. Nothing is shown as on. Reload to try again.</p>
      ) : (
        <>
          <section className="mt-6">
            <h2 className="text-lg font-medium">Current: <span data-testid="rollout-mode">{mode}</span></h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">Last changed by {lastBy}{rows[0]?.updated_at ? ` on ${rows[0].updated_at.slice(0, 10)}` : ""}.</p>
            <form action={setMode} className="mt-3 flex flex-wrap items-end gap-3">
              <label className="text-sm">Set to
                <select name="mode" defaultValue={mode ?? "off"} className="ml-2 rounded border px-2 py-1">
                  <option value="off">Off</option>
                  <option value="pilot">Pilot studios only</option>
                  <option value="all">All studios</option>
                </select>
              </label>
              <label className="text-sm">To choose All, type {ALL_CONFIRM_PHRASE}
                <input name="confirm" autoComplete="off" className="ml-2 rounded border px-2 py-1" />
              </label>
              <button className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">Save</button>
            </form>
          </section>
          <section className="mt-8">
            <h2 className="text-lg font-medium">Pilot studios</h2>
            {pilots.length === 0 ? <p className="mt-2 text-sm">None.</p> : (
              <ul className="mt-2 divide-y">
                {pilots.map((p) => (
                  <li key={p.studio_id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span>{p.studio_name} <span className="text-neutral-500">added by {p.added_by ? addedBy.get(p.added_by) ?? "unknown" : "unknown"}{p.added_at ? ` on ${p.added_at.slice(0, 10)}` : ""}</span></span>
                    <form action={remove}><input type="hidden" name="studioId" value={p.studio_id ?? ""} /><button className="rounded border px-2 py-1">Remove</button></form>
                  </li>
                ))}
              </ul>
            )}
            <form action={add} className="mt-3 flex items-end gap-3">
              <label className="text-sm">Add a studio
                <select name="studioId" className="ml-2 rounded border px-2 py-1" defaultValue="">
                  <option value="" disabled>Choose a studio</option>
                  {choices.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <button className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">Add</button>
            </form>
          </section>
        </>
      )}
    </main>
  );
}
