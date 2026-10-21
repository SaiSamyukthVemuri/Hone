import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { adminQuery, asUser, closePool, seedStudio } from "./helpers/harness";
import { countVersion } from "../migrations/helpers/migration-state";
import {
  EXPORT_PAGE_SIZE,
  loadClinicalRecordsForExport,
  recordClinicalRecordsAudit,
} from "@/lib/clinical-records/export-queries";
import { buildClinicalRecordsDocument } from "@/lib/clinical-records/export-scope";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExportSessionTreatments } from "@/app/(records-export)/clients/[id]/records/export/session-treatments";
import { mintPrintToken, PRINT_TOKEN_TTL_MS } from "@/lib/clinical-records/print-token";
import { recordClinicalRecordsPrintAction } from "@/app/(records-export)/clients/[id]/records/export/actions";
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

// CANDIDATE-COMPOSITION cases need a command a LATER migration adds. They RUN
// on a chain that has it (the composed candidate, 0213-0233) and SKIP, by
// name, on one that does not (#896 alone). Detected from the live catalog,
// never assumed from a file list.
async function hasFunction(name: string): Promise<boolean> {
  const r = await adminQuery(
    `select exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public' and p.proname = $1) as ok`,
    [name],
  );
  return r.rows[0].ok === true;
}
const HAS_INITIAL_SAVE = await hasFunction("create_block_with_initial_setup"); // 0223

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

  it("omits the active children of a SOFT-DELETED block; a true legacy entry still prints (Codex P1 4302941115)", async () => {
    const s = await seedStudio("hon46del");
    studios.push(s.studioId);
    const session = await adminQuery(
      `insert into public.sessions (studio_id, client_id, practitioner_id, modality, started_at)
       values ($1, $2, $3, 'electrolysis', ($4::date + time '15:00') at time zone 'America/Toronto') returning id`,
      [s.studioId, s.clientId, s.practitionerId, DAY],
    );
    const sessionId = session.rows[0].id as string;
    const blocks = await adminQuery(
      `insert into public.session_blocks (studio_id, session_id, sort_order, primary_area)
       values ($1, $2, 0, 'chin'), ($1, $2, 1, 'upper lip') returning id, primary_area`,
      [s.studioId, sessionId],
    );
    const liveBlock = blocks.rows.find((r) => r.primary_area === "chin")!.id as string;
    const deletedBlock = blocks.rows.find((r) => r.primary_area === "upper lip")!.id as string;
    const entries = await adminQuery(
      `insert into public.electrolysis_entries (session_id, block_id, area)
       values ($1, $2, 'chin'), ($1, $3, 'upper lip'), ($1, null, 'jaw') returning id, area`,
      [sessionId, liveBlock, deletedBlock],
    );
    const idOf = (area: string) => entries.rows.find((r) => r.area === area)!.id as string;
    // Block-only soft delete: the block is gone, its child entry stays ACTIVE.
    await adminQuery(`update public.session_blocks set deleted_at = now() where id = $1`, [deletedBlock]);
    const child = await adminQuery(`select deleted_at from public.electrolysis_entries where id = $1`, [idOf("upper lip")]);
    expect(child.rows[0].deleted_at).toBeNull();

    await signInOwner(s.practitionerId);
    const args = { studioId: s.studioId, clientId: s.clientId, scope: { kind: "day" as const, day: DAY }, timezone: "America/Toronto" };
    let load = await loadClinicalRecordsForExport(args);
    for (let attempt = 0; !load.ok && attempt < 20; attempt += 1) {
      await new Promise((r) => setTimeout(r, 250));
      load = await loadClinicalRecordsForExport(args);
    }
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    // The query DOES return the orphaned child: the bug was in what we did with it.
    expect(load.value.entries.map((e) => e.id)).toContain(idOf("upper lip"));
    const doc = buildClinicalRecordsDocument(load.value);
    expect(JSON.stringify(doc)).not.toContain(idOf("upper lip"));
    const exported = doc.sessions.find((x) => x.id === sessionId)!;
    expect(exported.blocks.map((b) => b.id)).toEqual([liveBlock]);
    expect(exported.blocks[0].record.electrolysis_entries.map((e) => e.id)).toEqual([idOf("chin")]);
    expect(exported.entries.map((e) => e.id)).toEqual([idOf("jaw")]);
  }, 60_000);

  // NOT GREEN-BY-SKIP: on a tree that CARRIES 0223 the gate must be open, so
  // the initial-save case below can only skip where 0223 truly is absent.
  it("the initial-save gate is open wherever the tree carries 0223", () => {
    if (countVersion("0223") > 0) expect(HAS_INITIAL_SAVE, "0223 is in the tree but create_block_with_initial_setup is not in the catalog").toBe(true);
  });

  it.runIf(HAS_INITIAL_SAVE)("a treatment area saved through 0223's INITIAL SAVE prints the values it stored (candidate composition; skips without create_block_with_initial_setup from 0223)", async () => {
    const s = await seedStudio("hon46mpx");
    studios.push(s.studioId);
    const session = await adminQuery(
      `insert into public.sessions (studio_id, client_id, practitioner_id, modality, started_at)
       values ($1, $2, $3, 'electrolysis', ($4::date + time '15:00') at time zone 'America/Toronto') returning id`,
      [s.studioId, s.clientId, s.practitionerId, DAY],
    );
    const sessionId = session.rows[0].id as string;
    // A synthetic machine and one recorded setting group, as machine-initial-save.db.test.ts does.
    const PROFILE = "fixture:hon46-export";
    await adminQuery(`select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)`, [
      PROFILE,
      1,
      "galvanic",
      4,
      null,
      JSON.stringify([{ field_key: "current", native_unit: "µA", decimals: 0, quantity: "current", optional: true }]),
    ]);
    const machineId = await asUser(s.userId, async (q) => {
      const r = await q(`select public.register_studio_machine($1,$2,$3,$4,$5) as id`, [s.studioId, PROFILE, 1, "Room 1", []]);
      return r.rows[0].id as string;
    });
    // Distinct numbers, so a value printed under the wrong label cannot pass.
    const saved = await asUser(s.userId, async (q) => {
      const r = await q(
        `select public.create_block_with_initial_setup(
          $1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6,$7,$8::text[],$9,$10,$11,$12,$13,$14,
          $15::jsonb,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
          $27,$28,$29,$30::jsonb) as r`,
        [
          sessionId, s.clientId,
          JSON.stringify({ block_name: "Initial save", mode: "blend", energy_level: 9, minutes_performed: 8, primary_area: "jaw" }),
          JSON.stringify({}), JSON.stringify([]), true, "chin", ["chin"], null, null,
          "blend", 3, 1.5, "hon46 initial save", JSON.stringify(["Coarse hair"]), null, 11, 22, null, null,
          33, 44.5, 55, 66, 77.5, 88.5,
          machineId, "galvanic", "hon46-initial-save-0001",
          // A NEW group is named by `new_group_ref`, never `group_key`: the
          // database issues group identities (final 0223; #860's
          // group-identity-serialisation rule), and an initial save has no
          // existing group to revise. The key is OMITTED, never sent as null.
          JSON.stringify([{ new_group_ref: "g1", channels: [1], readings: [{ field_key: "current", value: "120", observation_source: "practitioner-entered" }] }]),
        ],
      );
      return r.rows[0].r as { block_id: string; entry_id: string | null; setup: { readings: number } | null };
    });
    expect(saved.entry_id).toBeTruthy();
    expect(saved.setup?.readings).toBe(1);

    await signInOwner(s.practitionerId);
    const args = { studioId: s.studioId, clientId: s.clientId, scope: { kind: "day" as const, day: DAY }, timezone: "America/Toronto" };
    let load = await loadClinicalRecordsForExport(args);
    for (let attempt = 0; !load.ok && attempt < 20; attempt += 1) {
      await new Promise((r) => setTimeout(r, 250));
      load = await loadClinicalRecordsForExport(args);
    }
    expect(load.ok).toBe(true);
    if (!load.ok) return;
    const doc = buildClinicalRecordsDocument(load.value);
    const block = doc.sessions.find((x) => x.id === sessionId)!.blocks.find((b) => b.id === saved.block_id)!;
    // The ROWS reach the printout intact, every stored value (PostgREST types).
    expect(block.record).toMatchObject({ mode: "blend", energy_level: 9, minutes_performed: 8 });
    const entry = block.record.electrolysis_entries.find((e) => e.id === saved.entry_id)!;
    expect(entry).toMatchObject({
      energy_level: 11,
      minutes_performed: 22,
      hairs_treated: 33,
      galvanic_ma: 44.5,
      galvanic_duration_seconds: 55,
      thermolysis_intensity_percent: 66,
      thermolysis_duration_seconds: 77.5,
      units_of_lye: 88.5,
      pulse_count: 3,
      observation_chips: ["Coarse hair"],
      comments: "hon46 initial save",
    });
    expect(Number(entry.pulse_delay_seconds)).toBe(1.5);
    // ...and PRINT as the saved view shows them: the area's own settings on
    // its header line, each pass reading under its own group, in machine order.
    const printed = renderToStaticMarkup(createElement(ExportSessionTreatments, { session: doc.sessions.find((x) => x.id === sessionId)! }))
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
    for (const shown of [
      "Blend · EL 9 · 8 min",
      "Galvanic: 88.5 UL · 55s · 44.5 mA",
      "Thermolysis: 77.5 seconds · 66% · 3 pulses · 1.50s delay",
      "Hairs treated: 33",
      "Coarse hair",
      "Notes: hon46 initial save",
    ]) {
      expect(printed, shown).toContain(shown);
    }
  }, 60_000);

  it("the PRINT audit is bound to the rendered preview: forged, foreign and expired tokens audit nothing (Codex P1 4303617257)", async () => {
    process.env.APPOINTMENT_SIGNING_SECRET ||= "db-test-signing-secret";
    const s = await seedStudio("hon46print");
    const other = await seedStudio("hon46print-other");
    studios.push(s.studioId, other.studioId);
    // A second client in the SAME studio: the forgery target.
    const victim = await adminQuery(`insert into public.clients (studio_id, name) values ($1, 'Victim') returning id`, [s.studioId]);
    const victimId = victim.rows[0].id as string;
    await signInOwner(s.practitionerId);
    const printRows = async (clientId: string) =>
      (
        await adminQuery(
          `select metadata from public.audit_logs where entity_id = $1 and action = 'clinical_records_printed' order by created_at`,
          [clientId],
        )
      ).rows.map((r) => r.metadata as Record<string, string>);
    // The token cites a REAL preview row (0233 F3: a print must reference this
    // owner's own preview of this client).
    const previewAuditId = randomUUID();
    let pre = await recordClinicalRecordsAudit({
      id: previewAuditId,
      clientId: s.clientId,
      action: "clinical_records_previewed",
      metadata: { scope: "day", day: DAY },
    });
    for (let attempt = 0; !pre.ok && attempt < 20; attempt += 1) {
      await new Promise((res) => setTimeout(res, 250));
      pre = await recordClinicalRecordsAudit({
        id: previewAuditId,
        clientId: s.clientId,
        action: "clinical_records_previewed",
        metadata: { scope: "day", day: DAY },
      });
    }
    expect(pre).toEqual({ ok: true });
    const base = {
      studioId: s.studioId,
      clientId: s.clientId,
      actorId: s.practitionerId,
      previewAuditId,
      scope: { kind: "day" as const, day: DAY },
    };
    const forge = (token: string, change: (p: Record<string, unknown>) => void) => {
      const [payload, sig] = token.split(".");
      const obj = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
      change(obj);
      return `${Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}.${sig}`;
    };
    const honest = mintPrintToken(base)!;

    // Forged client and forged scope: refused, NO audit row anywhere.
    expect(await recordClinicalRecordsPrintAction(forge(honest, (p) => (p.clientId = victimId)))).toEqual({ ok: false });
    expect(
      await recordClinicalRecordsPrintAction(forge(honest, (p) => (p.scope = { kind: "range", from: "2026-01-01", to: "2026-12-31" }))),
    ).toEqual({ ok: false });
    // A genuine token from ANOTHER studio, and an expired one: refused.
    expect(await recordClinicalRecordsPrintAction(mintPrintToken({ ...base, studioId: other.studioId })!)).toEqual({ ok: false });
    expect(await recordClinicalRecordsPrintAction(mintPrintToken(base, Date.now() - PRINT_TOKEN_TTL_MS - 60_000)!)).toEqual({
      ok: false,
    });
    expect(await printRows(victimId)).toEqual([]);
    expect(await printRows(s.clientId)).toEqual([]);

    // The honest path still audits: exactly the minted client and scope,
    // linked to the preview it was bound to. (Retried only for the brief
    // PGRST303 window of a freshly minted session JWT.)
    let r = await recordClinicalRecordsPrintAction(honest);
    for (let attempt = 0; !r.ok && attempt < 20; attempt += 1) {
      await new Promise((res) => setTimeout(res, 250));
      r = await recordClinicalRecordsPrintAction(honest);
    }
    expect(r).toEqual({ ok: true });
    expect(await printRows(s.clientId)).toEqual([{ scope: "day", day: DAY, preview_audit_id: base.previewAuditId }]);
    expect(await printRows(victimId)).toEqual([]);
  }, 60_000);

  it("the REAL export path records the owner's preview AND print through the actor-bound command (0233)", async () => {
    process.env.APPOINTMENT_SIGNING_SECRET ||= "db-test-signing-secret";
    const s = await seedStudio("hon46rpc");
    studios.push(s.studioId);
    await signInOwner(s.practitionerId);
    const previewId = randomUUID();
    // Preview: exactly the call the page makes.
    let r = await recordClinicalRecordsAudit({
      id: previewId,
      clientId: s.clientId,
      action: "clinical_records_previewed",
      metadata: { scope: "day", day: DAY },
    });
    for (let attempt = 0; !r.ok && attempt < 20; attempt += 1) {
      await new Promise((res) => setTimeout(res, 250));
      r = await recordClinicalRecordsAudit({
        id: previewId,
        clientId: s.clientId,
        action: "clinical_records_previewed",
        metadata: { scope: "day", day: DAY },
      });
    }
    expect(r).toEqual({ ok: true });
    // Print: through the print action, bound to that preview.
    const token = mintPrintToken({
      studioId: s.studioId,
      clientId: s.clientId,
      actorId: s.practitionerId,
      previewAuditId: previewId,
      scope: { kind: "day", day: DAY },
    })!;
    expect(await recordClinicalRecordsPrintAction(token)).toEqual({ ok: true });
    const rows = await adminQuery(
      `select id, action, actor_id, studio_id, metadata from public.audit_logs
        where entity_id = $1 and action like 'clinical_records_%' order by created_at`,
      [s.clientId],
    );
    expect(rows.rows.map((x) => [x.action, x.actor_id, x.studio_id])).toEqual([
      ["clinical_records_previewed", s.practitionerId, s.studioId],
      ["clinical_records_printed", s.practitionerId, s.studioId],
    ]);
    expect(rows.rows[0].id).toBe(previewId);
    expect(rows.rows[1].metadata).toEqual({ scope: "day", day: DAY, preview_audit_id: previewId });
  }, 60_000);

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
