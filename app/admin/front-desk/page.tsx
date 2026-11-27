import { redirect } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/auth/require-platform-admin";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { parseFrontDeskListing, REASON_MAX, SEAT_SOURCES } from "@/lib/rollouts/front-desk-admin";
import { grantSeatsAction, revokeSeatsAction, setStudioFrontDeskAction, type FrontDeskActionResult } from "./actions";

// Platform-admin control for the Front Desk: switch it on or off per studio and grant or revoke receptionist seats (0390). Admin-only: the layout
// redirects non-admins, this page re-checks, and every action re-checks again. It shows studio NAMES only; an id travels only in a form's hidden value.
// Grant reasons are shown here, to platform admins, and nowhere else.

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Plain module-level helpers: an inline "use server" action may not close over a function (Next cannot serialise it), so these live here.
function finish(result: FrontDeskActionResult, id: string | null): never {
  const back = id && UUID.test(id) ? `studio=${id}&` : "";
  redirect(`/admin/front-desk?${back}ok=${result.ok ? "1" : "0"}&notice=${encodeURIComponent(result.message)}`);
}
function idOf(fd: FormData): string | null {
  const v = fd.get("studioId");
  return typeof v === "string" ? v : null;
}

export default async function FrontDeskAdminPage({ searchParams }: { searchParams: Promise<{ studio?: string; notice?: string; ok?: string }> }) {
  await requirePlatformAdmin();
  const sp = await searchParams;
  const admin = createAdminClient();
  const { data: studios } = await admin.from("studios").select("id, name").order("name", { ascending: true }).limit(500);
  const choices = (studios ?? []) as { id: string; name: string }[];
  const studioId = typeof sp.studio === "string" && UUID.test(sp.studio) ? sp.studio.toLowerCase() : null;
  const studio = studioId ? choices.find((s) => s.id === studioId) ?? null : null;
  const read = studio ? await admin.rpc("admin_list_front_desk", { p_studio_id: studio.id }) : null;
  const listing = read && !read.error ? parseFrontDeskListing(read.data) : null;

  async function setOn(fd: FormData) { "use server"; finish(await setStudioFrontDeskAction(fd), idOf(fd)); }
  async function grant(fd: FormData) { "use server"; finish(await grantSeatsAction(fd), idOf(fd)); }
  async function revoke(fd: FormData) { "use server"; finish(await revokeSeatsAction(fd), idOf(fd)); }

  const reasonHelp = "Why these seats are granted or revoked. Write no client or personal details.";
  return (
    <main className="mx-auto max-w-3xl px-5 py-8 md:px-8">
      <h1 className="text-2xl font-semibold">Front desk: switch and seats</h1>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
        The front desk is available to a studio only where it is switched on here, and only for as many receptionists as the studio has live seats. The
        global setting still switches it off everywhere. Revoking seats never deletes a receptionist or an invitation; anyone beyond the new limit simply
        cannot use the front desk until seats are added again.
      </p>
      {sp.notice ? <p role="status" className={`mt-4 rounded border px-3 py-2 text-sm ${sp.ok === "1" ? "border-green-600" : "border-red-600"}`}>{sp.notice.slice(0, 200)}</p> : null}
      <form method="get" className="mt-6 flex flex-wrap items-end gap-3">
        <label className="block min-w-0 max-w-full flex-1 text-sm">Studio
          <select name="studio" defaultValue={studio?.id ?? ""} className="mt-1 block w-full min-w-0 rounded border px-2 py-1">
            <option value="" disabled>Choose a studio</option>
            {choices.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <button className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">Show</button>
      </form>
      {studio && listing === null ? (
        <p role="alert" className="mt-6 rounded border border-red-600 px-3 py-2 text-sm">This studio&rsquo;s setting could not be read. Nothing is shown as on. Reload to try again.</p>
      ) : null}
      {studio && listing ? (
        <>
          <section className="mt-6">
            <h2 className="text-lg font-medium">{studio.name}: front desk is <span data-testid="front-desk-switch">{listing.switchOn ? "on" : "off"}</span></h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              {listing.seatsActive + listing.seatsReserved} of {listing.seatLimit} seats used ({listing.seatsActive} active, {listing.seatsReserved} reserved for pending invitations)
              {listing.seatsOverLimit > 0 ? `; ${listing.seatsOverLimit} over the limit` : ""}.
            </p>
            <form action={setOn} className="mt-3">
              <input type="hidden" name="studioId" value={studio.id} />
              <input type="hidden" name="on" value={listing.switchOn ? "false" : "true"} />
              <button className="rounded border px-3 py-1.5 text-sm">{listing.switchOn ? "Switch off for this studio" : "Switch on for this studio"}</button>
            </form>
          </section>
          <section className="mt-8">
            <h2 className="text-lg font-medium">Seat grants</h2>
            {listing.seats.length === 0 ? <p className="mt-2 text-sm">None.</p> : (
              <ul className="mt-2 divide-y">
                {listing.seats.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
                    <span>
                      {g.seats} {g.seats === 1 ? "seat" : "seats"} ({g.source.replace("_", " ")}), {g.state}
                      <span className="text-neutral-500"> granted {g.grantedAt.slice(0, 10)}{g.expiresAt ? `, expires ${g.expiresAt.slice(0, 10)}` : ""}</span>
                      {g.reason ? <span className="block text-neutral-500">{g.reason}</span> : null}
                    </span>
                    {g.state === "live" ? (
                      <form action={revoke} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="studioId" value={studio.id} />
                        <input type="hidden" name="seatId" value={g.id} />
                        <input name="reason" required maxLength={REASON_MAX} placeholder="Reason (no client or personal details)" aria-label="Reason for revoking" autoComplete="off" className="w-64 max-w-full rounded border px-2 py-1" />
                        <button className="rounded border px-2 py-1">Revoke</button>
                      </form>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <form action={grant} className="mt-4 flex flex-wrap items-end gap-3">
              <input type="hidden" name="studioId" value={studio.id} />
              <label className="text-sm">Seats <input name="seats" type="number" min={1} max={50} defaultValue={1} required className="ml-2 w-16 rounded border px-2 py-1" /></label>
              <label className="text-sm">Source
                <select name="source" defaultValue="pilot" className="ml-2 rounded border px-2 py-1">
                  {SEAT_SOURCES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
                </select>
              </label>
              <label className="text-sm">Expires (optional) <input name="expiresAt" type="date" className="ml-2 rounded border px-2 py-1" /></label>
              <label className="w-full text-sm">Reason <span className="text-neutral-500">{reasonHelp}</span>
                <input name="reason" required maxLength={REASON_MAX} autoComplete="off" className="mt-1 w-full rounded border px-2 py-1" />
              </label>
              <button className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white">Grant seats</button>
            </form>
          </section>
        </>
      ) : null}
    </main>
  );
}
