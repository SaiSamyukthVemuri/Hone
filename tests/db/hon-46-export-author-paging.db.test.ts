import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { adminQuery, closePool, seedStudio } from "./helpers/harness";
import { EXPORT_PAGE_SIZE, loadClinicalRecordsForExport } from "@/lib/clinical-records/export-queries";
import { buildClinicalRecordsDocument } from "@/lib/clinical-records/export-scope";
import {
  E2E_SERVICE_ROLE_KEY,
  E2E_SUPABASE_URL,
  E2E_WEB_SERVER_ENV,
} from "../../e2e/helpers/local-env";

// HON-46: the clinical records export reads to COMPLETION against the real
// local PostgREST (max_rows 1000), as the signed-in owner, through the
// PRODUCTION loader. A read that silently stopped at one chunk of ids or one
// page of rows would print a real author as "Unknown practitioner", or drop
// clinical notes, with nothing to show it happened (Codex P2 4302690102).
//
// The seed crosses BOTH boundaries: more distinct authors than one .in() chunk
// (100) holds, and more notes on the day than one page (EXPORT_PAGE_SIZE).

// The app's server client reads auth from next/headers cookies. Serve it the
// cookies @supabase/ssr itself writes for a real local GoTrue session (the
// owner-capacity / HON-45 DB tests' pattern).
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
  }),
}));
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}
const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const AUTHORS = 250; // three chunks of 100
const NOTES = EXPORT_PAGE_SIZE + 200; // two pages
const DAY = "2026-09-15";

const studios: string[] = [];
afterAll(async () => {
  for (const id of studios) {
    await adminQuery(`delete from public.client_clinical_notes where studio_id = $1`, [id]).catch(() => undefined);
  }
  await closePool();
});

/** A real GoTrue session for the studio OWNER, written into the cookie jar. */
async function signInOwner(practitionerId: string): Promise<void> {
  const email = `hon46-${randomUUID().slice(0, 8)}@harness.local`;
  const password = `Pw-${randomUUID()}`;
  const created = await fetch(`${E2E_SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: E2E_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${E2E_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.ok) throw new Error(`local GoTrue createUser failed: ${created.status}`);
  const authUser = (await created.json()) as { id: string };
  await adminQuery(`update public.practitioners set user_id = $2, email = $3 where id = $1`, [
    practitionerId,
    authUser.id,
    email,
  ]);
  const token = await fetch(`${E2E_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!token.ok) throw new Error(`local sign-in failed: ${token.status}`);
  const session = (await token.json()) as { access_token: string; refresh_token: string };
  const cookies = new Map<string, string>();
  const writer = createServerClient(E2E_SUPABASE_URL, ANON, {
    cookies: {
      getAll: () => [...cookies.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list: Array<{ name: string; value: string }>) =>
        list.forEach(({ name, value }) => cookies.set(name, value)),
    },
  });
  await writer.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  if (cookies.size === 0) throw new Error("no auth cookie was written");
  process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
  jar.clear();
  for (const [name, value] of cookies) jar.set(name, value);
}

describe("HON-46 export reads every author and every note to completion", () => {
  it(`resolves all ${AUTHORS} authors of ${NOTES} same-day notes (chunk and page boundaries)`, async () => {
    const s = await seedStudio("hon46pg");
    studios.push(s.studioId);

    // AUTHORS member practitioners, each with a distinct, checkable name.
    const members = await adminQuery(
      `with u as (
         insert into auth.users (id, email)
         select gen_random_uuid(), 'hon46pg-' || g || '-' || substr(gen_random_uuid()::text, 1, 8) || '@harness.local'
           from generate_series(1, $2::int) g
         returning id, email
       ), n as (select id, email, row_number() over (order by email) as g from u)
       insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active)
       select gen_random_uuid(), $1, n.id, 'Author ' || lpad(n.g::text, 3, '0'), n.email, 'practitioner', true
         from n
       returning id, display_name`,
      [s.studioId, AUTHORS],
    );
    const expected = new Map<string, string>(
      members.rows.map((r) => [r.id as string, r.display_name as string]),
    );
    expect(expected.size).toBe(AUTHORS);

    // NOTES civil-dated notes on DAY, the authors taken round-robin so every
    // one of them is referenced.
    const ids = [...expected.keys()];
    await adminQuery(
      `insert into public.client_clinical_notes (client_id, studio_id, practitioner_id, kind, body, occurred_at)
       select $1, $2, ($3::uuid[])[1 + (g % $4::int)], 'consultation', 'paging note ' || g, $5::date
         from generate_series(0, $6::int - 1) g`,
      [s.clientId, s.studioId, ids, AUTHORS, DAY, NOTES],
    );

    await signInOwner(s.practitionerId);
    let load = await loadClinicalRecordsForExport({
      studioId: s.studioId,
      clientId: s.clientId,
      scope: { kind: "day", day: DAY },
      timezone: "America/Toronto",
    });
    // A newly minted JWT can briefly read as issued in the future (PGRST303)
    // while the containers' clocks settle; retried, never accepted.
    for (let attempt = 0; !load.ok && attempt < 20; attempt += 1) {
      await new Promise((r) => setTimeout(r, 250));
      load = await loadClinicalRecordsForExport({
        studioId: s.studioId,
        clientId: s.clientId,
        scope: { kind: "day", day: DAY },
        timezone: "America/Toronto",
      });
    }
    expect(load.ok).toBe(true);
    if (!load.ok) return;

    // Every note, across the page boundary.
    expect(load.value.notes).toHaveLength(NOTES);
    expect(new Set(load.value.notes.map((n) => n.id)).size).toBe(NOTES);
    // Every author, across the chunk boundary, by its own name.
    const missing = ids.filter((id) => load.ok && load.value.practitionerNameById.get(id) !== expected.get(id));
    expect(missing).toEqual([]);
    expect(load.value.practitionerNameById.size).toBe(AUTHORS);
  }, 120_000);

  it("labels a note superseded by a revision dated OUTSIDE the range (Codex P1 4302740025)", async () => {
    const s = await seedStudio("hon46sup");
    studios.push(s.studioId);
    const orig = await adminQuery(
      `insert into public.client_clinical_notes (client_id, studio_id, practitioner_id, kind, body, occurred_at)
       values ($1, $2, $3, 'consultation', 'original text', $4::date) returning id`,
      [s.clientId, s.studioId, s.practitionerId, DAY],
    );
    const originalId = orig.rows[0].id as string;
    // The revision is recorded a month later, so it is NOT in the day's export.
    await adminQuery(
      `insert into public.client_clinical_notes
         (client_id, studio_id, practitioner_id, kind, body, occurred_at, supersedes_note_id)
       values ($1, $2, $3, 'consultation', 'revised text', ($4::date + 30), $5)`,
      [s.clientId, s.studioId, s.practitionerId, DAY, originalId],
    );
    // A same-day note nothing supersedes stays current.
    await adminQuery(
      `insert into public.client_clinical_notes (client_id, studio_id, practitioner_id, kind, body, occurred_at)
       values ($1, $2, $3, 'skin_hair_analysis', 'current text', $4::date)`,
      [s.clientId, s.studioId, s.practitionerId, DAY],
    );

    await signInOwner(s.practitionerId);
    const args = { studioId: s.studioId, clientId: s.clientId, scope: { kind: "day" as const, day: DAY }, timezone: "America/Toronto" };
    let load = await loadClinicalRecordsForExport(args);
    for (let attempt = 0; !load.ok && attempt < 20; attempt += 1) {
      await new Promise((r) => setTimeout(r, 250));
      load = await loadClinicalRecordsForExport(args);
    }
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    const notes = buildClinicalRecordsDocument(load.value).clinicalNotes;
    expect(notes.map((n) => [n.body, n.isSuperseded]).sort()).toEqual([
      ["current text", false],
      ["original text", true],
    ]);
  }, 60_000);
});
