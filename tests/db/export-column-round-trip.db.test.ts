import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  E2E_SERVICE_ROLE_KEY,
  E2E_SUPABASE_URL,
  E2E_WEB_SERVER_ENV,
} from "@/e2e/helpers/local-env";
import { exportSpec } from "@/lib/export/resource-registry";
import { adminQuery, closePool, seedStudio } from "@/tests/db/helpers/harness";

// ===========================================================================
// THE VALUE END OF THE CHAIN — proved with real rows, real RLS
// ===========================================================================
//
// Codex P1 on head 25c066ab. Declaration arithmetic cannot prove a value moved.
// The registry can say a column is included, the header can be present, the
// SELECT can ask for it, and the cell can still arrive empty or holding the
// wrong thing — a rename that points at the wrong field, a jsonb flatten that
// reads the wrong key, a joined label that resolves to null.
//
// So this suite writes real rows into the migrated local database, signs in as
// a real studio owner through local GoTrue, runs the REAL export action through
// its ordinary RLS-scoped path, and reads the values back out of the archive.
// Nothing is mocked except Next's cookie store, which this process has no
// request to supply.
//
// It covers the three shapes a value can take on the way out:
//
//   PLAIN      the column is emitted under its own name (clients, sessions)
//   RENAMED    laser_entries.session_number -> treatment_number
//   FLATTENED  laser_entries.equipment_params -> fluence / pulse_width / spot_size
//   DERIVED    session_blocks fields lifted onto electrolysis_entries rows
//
// It deliberately does NOT re-seed all fifteen tables: the middle link (is the
// column actually asked for?) is proved for every resource in
// tests/app/settings/data/export-emission-parity.test.ts from the recorded
// SELECT, and the shapes above are where a value can be lost between the row
// and the cell.

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

// ---------------------------------------------------------------------------
// RFC-4180 reader. lib/csv.ts PRESERVES embedded CR/LF inside quoted fields, so
// splitting on newlines would tear a multiline note in half; the seed below
// includes a comma and a quote on purpose so this is exercised rather than
// assumed.
// ---------------------------------------------------------------------------
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ",") { row.push(cell); cell = ""; continue; }
    if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    if (ch === "\r") continue;
    cell += ch;
  }
  if (cell.length > 0 || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}

type Table = { headers: string[]; rows: Array<Record<string, string>> };

function asTable(csv: string): Table {
  const parsed = parseCsv(csv).filter((r) => r.length > 1 || r[0] !== "");
  const headers = parsed[0] ?? [];
  const rows = parsed.slice(1).map((cells) => {
    const record: Record<string, string> = {};
    headers.forEach((h, i) => (record[h] = cells[i] ?? ""));
    return record;
  });
  return { headers, rows };
}

const SEED = {
  clientName: `Round Trip, Client "Q"`,
  pronouns: "she/her",
  dob: "1988-04-17",
  fitzpatrick: 3,
  allergies: "lidocaine; latex",
  skinNotes: "Reactive around the jawline, tolerates blend well.",
  emergencyName: "Emergency Contact",
  emergencyPhone: "+1-555-0100",
  phone: "+1-555-0199",
  sessionNotes: "First visit.\nSecond line, with a comma.",
  pricePaid: 14500,
  zone: "Upper lip",
  laserSessionNumber: 7,
  fluence: "12.5 J/cm2",
  pulseWidth: "30 ms",
  spotSize: "10 mm",
  laserObservations: "Mild erythema, resolved in 20 minutes.",
  comments: "Client tolerated the pass well.",
  blockPrimaryArea: "Chin",
  blockSide: "bilateral",
  blockCustomDetail: "Below the lower lip only",
  probeLabel: "F2 Gold, 0.003",
};

let studioId = "";
let clientId = "";
let sessionId = "";
let blockId = "";
let laserEntryId = "";
let electEntryId = "";
let archive: JSZip;

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
  process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;

  const seeded = await seedStudio(`rt-${randomUUID().slice(0, 6)}`);
  studioId = seeded.studioId;

  // A REAL local GoTrue user, so the export runs under a genuine session and
  // real RLS rather than a stubbed client. Same pattern as
  // tests/db/client-profile-tab-queries.db.test.ts.
  const email = `rt-${randomUUID().slice(0, 8)}@harness.local`;
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

  const ownerId = randomUUID();
  await adminQuery(
    `insert into public.practitioners
       (id, studio_id, user_id, display_name, email, role, active)
     values ($1, $2, $3, 'Round Trip Owner', $4, 'owner', true)`,
    [ownerId, studioId, authUser.id, email],
  );

  clientId = randomUUID();
  await adminQuery(
    `insert into public.clients
       (id, studio_id, name, pronouns, date_of_birth, fitzpatrick_type, allergies,
        skin_notes, emergency_contact_name, emergency_contact_phone, email, phone)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      clientId, studioId, SEED.clientName, SEED.pronouns, SEED.dob, SEED.fitzpatrick,
      SEED.allergies, SEED.skinNotes, SEED.emergencyName, SEED.emergencyPhone,
      `rt-client-${randomUUID().slice(0, 8)}@harness.local`, SEED.phone,
    ],
  );

  sessionId = randomUUID();
  await adminQuery(
    `insert into public.sessions
       (id, studio_id, client_id, practitioner_id, performed_by_practitioner_id,
        modality, started_at, ended_at, price_paid_cents, session_notes)
     values ($1,$2,$3,$4,$4,'electrolysis', now() - interval '2 hours', now() - interval '1 hour', $5, $6)`,
    [sessionId, studioId, clientId, ownerId, SEED.pricePaid, SEED.sessionNotes],
  );

  blockId = randomUUID();
  await adminQuery(
    `insert into public.session_blocks
       (id, studio_id, session_id, sort_order, primary_area, side,
        custom_area_detail, probe_label, reaction_type)
     values ($1,$2,$3,1,$4,$5,$6,$7,'mild_redness')`,
    [blockId, studioId, sessionId, SEED.blockPrimaryArea, SEED.blockSide,
     SEED.blockCustomDetail, SEED.probeLabel],
  );

  electEntryId = randomUUID();
  await adminQuery(
    `insert into public.electrolysis_entries
       (id, session_id, area, areas, mode, pulse_count, comments, block_id,
        energy_level, hairs_treated, observation_chips)
     values ($1,$2,'Chin', array['Chin','Jawline'], 'blend', 4, $3, $4, 7, 130,
             '["dry_skin"]'::jsonb)`,
    [electEntryId, sessionId, SEED.comments, blockId],
  );

  laserEntryId = randomUUID();
  await adminQuery(
    `insert into public.laser_entries
       (id, session_id, zone, session_number, equipment_params, observation_notes)
     values ($1,$2,$3,$4,$5::jsonb,$6)`,
    [
      laserEntryId, sessionId, SEED.zone, SEED.laserSessionNumber,
      JSON.stringify({
        fluence: SEED.fluence,
        pulse_width: SEED.pulseWidth,
        spot_size: SEED.spotSize,
        // A fourth key the export does NOT flatten. Its absence from the CSV is
        // recorded in the registry's emittedAs note and asserted below.
        cooling: "cryogen",
      }),
      SEED.laserObservations,
    ],
  );

  const token = await fetch(`${E2E_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!token.ok) throw new Error(`local sign-in failed: ${token.status}`);
  const session = (await token.json()) as { access_token: string; refresh_token: string };
  const writer = createServerClient(E2E_SUPABASE_URL, ANON, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list: Array<{ name: string; value: string }>) =>
        list.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  await writer.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  if (jar.size === 0) throw new Error("no auth cookie was written");

  const { exportStudioDataAction } = await import(
    "@/app/(app)/settings/data/actions"
  );
  const result = await exportStudioDataAction();
  if (!result.ok) throw new Error(`export refused: ${result.error}`);
  archive = await JSZip.loadAsync(Buffer.from(result.base64, "base64"));
}, 90_000);

afterAll(async () => {
  await closePool();
});

async function table(resource: string): Promise<Table> {
  const file = exportSpec(resource).file;
  const entry = archive.files[file];
  if (!entry) throw new Error(`${file} is not in the archive`);
  return asTable(await entry.async("string"));
}

async function rowById(resource: string, id: string): Promise<Record<string, string>> {
  const t = await table(resource);
  const row = t.rows.find((r) => r.id === id);
  if (!row) throw new Error(`${resource}: seeded row ${id} is not in the CSV`);
  return row;
}

describe("PLAIN columns carry their real value into the cell", () => {
  it("the seeded client is in the archive with every included field intact", async () => {
    const row = await rowById("clients", clientId);
    expect(row.name).toBe(SEED.clientName);
    expect(row.pronouns).toBe(SEED.pronouns);
    expect(row.date_of_birth).toBe(SEED.dob);
    expect(row.fitzpatrick_type).toBe(String(SEED.fitzpatrick));
    expect(row.allergies).toBe(SEED.allergies);
    expect(row.skin_notes).toBe(SEED.skinNotes);
    expect(row.emergency_contact_name).toBe(SEED.emergencyName);
    // Both phone numbers start with "+", which lib/csv.ts neutralises with a
    // leading apostrophe so a spreadsheet cannot read the cell as a formula.
    // The value still round-trips; it is guarded, not altered. Asserted rather
    // than worked around, because the guard is the reason this is safe to open
    // in Excel.
    expect(row.emergency_contact_phone).toBe(`'${SEED.emergencyPhone}`);
    expect(row.phone).toBe(`'${SEED.phone}`);
    expect(row.created_at.length).toBeGreaterThan(0);
  });

  it("a value containing a comma, a quote and a newline survives the round trip", async () => {
    const client = await rowById("clients", clientId);
    expect(client.name).toContain(",");
    expect(client.name).toContain('"');
    const session = await rowById("sessions", sessionId);
    expect(session.session_notes).toBe(SEED.sessionNotes);
    expect(session.session_notes).toContain("\n");
  });

  it("no included column of a seeded row comes back empty", async () => {
    for (const [resource, id] of [
      ["clients", clientId],
      ["sessions", sessionId],
    ] as const) {
      const row = await rowById(resource, id);
      const spec = exportSpec(resource);
      const dbRow = await adminQuery(
        `select * from public.${resource} where id = $1`,
        [id],
      );
      for (const column of spec.includedColumns) {
        const dbValue = (dbRow.rows[0] as Record<string, unknown>)[column];
        if (dbValue === null || dbValue === undefined) continue;
        expect(
          row[column] ?? "",
          `${resource}.${column} is declared included and holds a value in the database, but its cell is empty`,
        ).not.toBe("");
      }
    }
  });
});

describe("RENAMED and FLATTENED columns land where the registry says they land", () => {
  it("session_number is emitted as treatment_number, carrying the real value", async () => {
    const row = await rowById("laser_entries", laserEntryId);
    expect(row.treatment_number).toBe(String(SEED.laserSessionNumber));
    // And the column's own name is NOT a header: the rename is the whole path.
    expect(exportSpec("laser_entries").csvHeaders).not.toContain("session_number");
  });

  it("equipment_params is flattened into three columns that hold its values", async () => {
    const row = await rowById("laser_entries", laserEntryId);
    expect(row.fluence).toBe(SEED.fluence);
    expect(row.pulse_width).toBe(SEED.pulseWidth);
    expect(row.spot_size).toBe(SEED.spotSize);
  });

  it("a jsonb key the flatten does not name reaches no cell, as the registry states", async () => {
    const csv = await archive.files[exportSpec("laser_entries").file].async("string");
    expect(csv).not.toContain("cryogen");
    expect(exportSpec("laser_entries").emittedAs?.equipment_params.note).toMatch(
      /does not reach the CSV/,
    );
  });

  it("the other laser columns are plain and unaffected", async () => {
    const row = await rowById("laser_entries", laserEntryId);
    expect(row.zone).toBe(SEED.zone);
    expect(row.observation_notes).toBe(SEED.laserObservations);
  });
});

describe("DERIVED headers are filled from the table the registry names", () => {
  it("the block fields reach the electrolysis row they belong to", async () => {
    const row = await rowById("electrolysis_entries", electEntryId);
    expect(row.block_primary_area).toBe(SEED.blockPrimaryArea);
    expect(row.block_side).toBe(SEED.blockSide);
    expect(row.block_custom_area_detail).toBe(SEED.blockCustomDetail);
    expect(row.probe_label).toBe(SEED.probeLabel);
    expect(row.block_areas.length).toBeGreaterThan(0);
  });

  it("the entry's own included columns carry their values too", async () => {
    const row = await rowById("electrolysis_entries", electEntryId);
    expect(row.area).toBe("Chin");
    expect(row.areas).toBe("Chin; Jawline");
    expect(row.mode).toBe("blend");
    expect(row.pulse_count).toBe("4");
    expect(row.energy_level).toBe("7");
    expect(row.hairs_treated).toBe("130");
    expect(row.comments).toBe(SEED.comments);
    // reaction_type is folded into the chip list rather than emitted alone.
    expect(row.observation_chips.length).toBeGreaterThan(0);
  });
});

describe("the export still refuses to describe what it did not write", () => {
  it("the manifest counts the seeded rows it actually emitted", async () => {
    const manifest = JSON.parse(await archive.files["manifest.json"].async("string"));
    expect(manifest.files["clients.csv"]).toBeGreaterThanOrEqual(1);
    expect(manifest.files["laser_entries.csv"]).toBeGreaterThanOrEqual(1);
    const clientsCheck = manifest.source_count_checks.find(
      (c: { table: string }) => c.table === "clients",
    );
    expect(clientsCheck.status).toBe("matched");
  });
});
