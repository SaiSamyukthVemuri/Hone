import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import JSZip from "jszip";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL, E2E_WEB_SERVER_ENV } from "@/e2e/helpers/local-env";
import { exportSpec } from "@/lib/export/resource-registry";
import { MACHINE_CATALOGUE } from "@/lib/machines/catalogue";
import { planContractPublication } from "@/lib/machines/contract-publication";
import { adminQuery, adminTx, asUser, closePool, RECORD_GROUP_SQL, seedSession, seedStudio, type SeededStudio } from "@/tests/db/helpers/harness";

// The owner's data export carries machine-native (MultiPlex) readings, with real rows, real RLS, real GoTrue, and the real export action:
//
//   * the readings file holds the studio's own rows and no other studio's;
//   * a native area's pulse count (3) and an intensity (1.85) come out as the machine showed them, and a recorded 1.8 at two decimals is "1.80";
//   * a field left blank is a reasoned absence, never a 0;
//   * the source-count check is real: one row lost on the way (here: from the wire, after the database answered) is reported as "mismatched" and the
//     export is REFUSED, while an untouched run reports "matched" and writes the file.
//
// The negative control tampers with the REST response for exactly that table, so the production code path, count query and all, is what notices.

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const jar = vi.hoisted(() => new Map<string, string>());
const tamper = vi.hoisted(() => ({ dropLastReadingRow: false }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

// The one client the export reads through, with a fetch that can lose the last row of the readings page (a GET on that table; the HEAD count is untouched).
vi.mock("@/lib/supabase/server", async () => {
  const { createServerClient: make } = await import("@supabase/ssr");
  const tamperingFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    if (!tamper.dropLastReadingRow || method !== "GET" || !url.includes("/rest/v1/treatment_setup_readings")) return res;
    const rows = (await res.json()) as unknown[];
    const headers = new Headers(res.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("content-range");
    return new Response(JSON.stringify(rows.slice(0, -1)), { status: res.status, headers });
  };
  return {
    createClient: async () =>
      make(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
        cookies: {
          getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
          setAll: (list: Array<{ name: string; value: string }>) => list.forEach(({ name, value }) => jar.set(name, value)),
        },
        global: { fetch: tamperingFetch },
      }),
  };
});

const PROFILE = `synthetic:hon118-${randomUUID().slice(0, 8)}`;
const MODE = "multiplex";

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
function asTable(csv: string) {
  const parsed = parseCsv(csv).filter((r) => r.length > 1 || r[0] !== "");
  const headers = parsed[0] ?? [];
  return { headers, rows: parsed.slice(1).map((cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]))) as Array<Record<string, string>> };
}

async function recordNativeArea(studio: SeededStudio, items: unknown[]): Promise<string> {
  const { sessionId, blockId } = await seedSession(studio);
  await asUser(studio.userId, async (q) => {
    const machine = (await q(`select public.register_studio_machine($1,$2,1,'Fixture machine','{}') as id`, [studio.studioId, PROFILE])).rows[0].id as string;
    const res = await q(RECORD_GROUP_SQL, [blockId, machine, MODE, "g1", [], JSON.stringify(items), sessionId, studio.clientId]);
    if (Number(res.rows[0].n) < 1) throw new Error("recording the fixture group wrote nothing");
  });
  return blockId;
}

// A native area recorded on the studio's per-studio "Machine not specified" placeholder (HON-119, migration 0385). The placeholder is made by the real
// command, ensure_unspecified_machine, which is fixed to the real xCell Pur MultiPlex profile, so the real shipped contract is published first (and removed
// again in afterAll: this file shares the stack with the 0385 test, which expects no published contract before it publishes one itself).
const PUR = "dectro-apilus:xcell-pur";
let purPublished = false;
async function publishRealPurContract(): Promise<void> {
  const plan = planContractPublication(MACHINE_CATALOGUE);
  const c = plan.publish.find((p) => p.p_machine_profile_id === PUR && p.p_mode_key === "multiplex");
  if (!c) throw new Error("the shipped catalogue no longer publishes xCell Pur MultiPlex");
  await adminQuery("select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)", [
    c.p_machine_profile_id, c.p_machine_profile_version, c.p_mode_key, c.p_channels_max, c.p_requires_installed_option, JSON.stringify(c.p_fields),
  ]);
  purPublished = true;
}
const UNSPECIFIED_GROUPS = JSON.stringify([{
  new_group_ref: "g1", channels: [],
  readings: [
    { field_key: "displayed_el", value: "12", observation_source: "machine-displayed" },
    { stage_key: "slow_thermolysis", field_key: "slow_thermolysis_duration", value: "1.85", observation_source: "practitioner-entered" },
    { stage_key: "slow_thermolysis", field_key: "slow_thermolysis_intensity", value: "30", observation_source: "practitioner-entered" },
    { stage_key: "snap", field_key: "snap_duration", value: "0.033", observation_source: "practitioner-entered" },
    { stage_key: "snap", field_key: "snap_intensity", value: "60", observation_source: "practitioner-entered" },
    { stage_key: "snap", field_key: "snap_count", value: "3", observation_source: "practitioner-entered" },
  ],
}]);
const UNSPECIFIED_READINGS = 6;
async function recordOnUnspecifiedMachine(studio: SeededStudio): Promise<{ blockId: string; machineId: string }> {
  await publishRealPurContract();
  const { sessionId, blockId } = await seedSession(studio);
  const machineId = (await asUser(studio.userId, (q) => q(`select public.ensure_unspecified_machine($1) as id`, [studio.studioId]))).rows[0].id as string;
  await asUser(studio.userId, (q) =>
    q(`select public.record_setup_submission_with_identity($1,$2,$3,$4,$5::jsonb,$6,$7)`, [blockId, machineId, "multiplex", `hon118-unspec-${randomUUID()}`.slice(0, 40), UNSPECIFIED_GROUPS, sessionId, studio.clientId]),
  );
  return { blockId, machineId };
}

let studioA: SeededStudio;
let blockA = "";
let blockU = "";
let unspecifiedMachineId = "";
let blockB = "";
let loginEmail = "";
let loginPassword = "";

async function signInAsStudioAOwner() {
  jar.clear();
  const token = await fetch(`${E2E_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email: loginEmail, password: loginPassword }),
  });
  if (!token.ok) throw new Error(`local sign-in failed: ${token.status}`);
  const session = (await token.json()) as { access_token: string; refresh_token: string };
  const writer = createServerClient(E2E_SUPABASE_URL, ANON, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list: Array<{ name: string; value: string }>) => list.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  await writer.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
  if (jar.size === 0) throw new Error("no auth cookie was written");
}

async function runExport() {
  const { exportStudioDataAction } = await import("@/app/(app)/settings/data/actions");
  return exportStudioDataAction();
}

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
  process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;

  // One contract for a synthetic native profile: an integer count (0 decimals), an intensity at two decimals, a second two-decimal field, and an optional
  // field that is left blank.
  await adminQuery(`select public.sync_machine_profile_contract($1,$2,$3,$4,$5,$6::jsonb)`, [
    PROFILE, 1, MODE, 4, null,
    JSON.stringify([
      { field_key: "snap_count", native_unit: "count", decimals: 0, quantity: "count", optional: true },
      { field_key: "intensity", native_unit: "%", decimals: 2, quantity: "percentage", optional: true },
      { field_key: "duration", native_unit: "s", decimals: 2, quantity: "duration", optional: true },
      { field_key: "blank_field", native_unit: "s", decimals: 2, quantity: "duration", optional: true },
      { field_key: "fine", native_unit: "s", decimals: 3, quantity: "duration", optional: true },
      { field_key: "big_count", native_unit: "count", decimals: 0, quantity: "count", optional: true },
    ]),
  ]);

  studioA = await seedStudio(`hon118-a-${randomUUID().slice(0, 6)}`);
  const studioB = await seedStudio(`hon118-b-${randomUUID().slice(0, 6)}`);
  blockA = await recordNativeArea(studioA, [
    { field_key: "snap_count", value: "3", observation_source: "practitioner-entered" },
    { field_key: "intensity", value: "1.85", observation_source: "practitioner-entered" },
    { field_key: "duration", value: "1.8", observation_source: "practitioner-entered" },
    { field_key: "blank_field", absence_reason: "not-recorded", observation_source: "practitioner-entered" },
    { field_key: "fine", value: "0.033", observation_source: "practitioner-entered" },
    // above 2^53: a JavaScript number would export ...992. The column is an unrestricted numeric and must stay exact.
    { field_key: "big_count", value: "9007199254740993", observation_source: "practitioner-entered" },
  ]);
  // The SAME studio, a reading on the unspecified-machine placeholder: its machine id must be exported blank.
  ({ blockId: blockU, machineId: unspecifiedMachineId } = await recordOnUnspecifiedMachine(studioA));
  // ANOTHER studio's native area, with values nobody in studio A may see.
  blockB = await recordNativeArea(studioB, [
    { field_key: "snap_count", value: "77", observation_source: "practitioner-entered" },
    { field_key: "intensity", value: "99.99", observation_source: "practitioner-entered" },
  ]);

  // A real GoTrue login for studio A's owner (the harness practitioner is backed by a bare auth.users row with no password).
  loginEmail = `hon118-${randomUUID().slice(0, 8)}@harness.local`;
  loginPassword = `Pw-${randomUUID()}`;
  const created = await fetch(`${E2E_SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: E2E_SERVICE_ROLE_KEY, Authorization: `Bearer ${E2E_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email: loginEmail, password: loginPassword, email_confirm: true }),
  });
  if (!created.ok) throw new Error(`local GoTrue createUser failed: ${created.status}`);
  const authUser = (await created.json()) as { id: string };
  await adminQuery(
    `insert into public.practitioners (id, studio_id, user_id, display_name, email, role, active) values ($1,$2,$3,'Fixture Owner',$4,'owner',true)`,
    [randomUUID(), studioA.studioId, authUser.id, loginEmail],
  );
}, 120_000);

afterAll(async () => {
  tamper.dropLastReadingRow = false;
  if (purPublished) {
    // Contract rows are immutable and referenced, so they go with the table owner and replication triggers off, in the owned throwaway stack only.
    await adminTx(async (q) => {
      await q(`set local session_replication_role = replica`);
      await q(`delete from public.machine_profile_field_contract where machine_profile_id=$1`, [PUR]);
      await q(`delete from public.machine_profile_mode_contract where machine_profile_id=$1`, [PUR]);
    }).catch(() => undefined);
  }
  await closePool();
});

describe("the readings file carries this studio's native readings, as the machine showed them", () => {
  it("3 and 1.85 for the native area, 1.8 at two decimals is 1.80, a blank field is an absence not a 0, and no other studio's rows", async () => {
    tamper.dropLastReadingRow = false;
    await signInAsStudioAOwner();
    const result = await runExport();
    if (!result.ok) throw new Error(`export refused: ${result.error}`);
    const archive = await JSZip.loadAsync(Buffer.from(result.base64, "base64"));
    const entry = archive.files[exportSpec("treatment_setup_readings").file];
    expect(entry, "the readings file is in the archive").toBeDefined();
    const t = asTable(await entry.async("string"));

    expect(t.headers).toEqual(exportSpec("treatment_setup_readings").csvHeaders);
    expect(t.headers, "the tenant key is not a column").not.toContain("studio_id");

    const own = t.rows.filter((r) => r.session_block_id === blockA);
    expect(own).toHaveLength(6);
    const by = (k: string) => own.find((r) => r.field_key === k)!;
    expect(by("snap_count").value_numeric).toBe("3");
    expect(by("intensity").value_numeric).toBe("1.85");
    expect(by("duration").value_numeric, "a recorded 1.8 at two decimals keeps its trailing zero").toBe("1.80");
    expect(by("fine").value_numeric).toBe("0.033");
    expect(by("big_count").value_numeric, "a value above 2^53 stays exact").toBe("9007199254740993");
    expect(by("blank_field").value_numeric, "a blank is never exported as 0").toBe("");
    expect(by("blank_field").absence_reason).toBe("not-recorded");
    expect(by("snap_count").native_unit).toBe("count");

    // another studio's rows are absent: by block and by value
    expect(t.rows.some((r) => r.session_block_id === blockB)).toBe(false);
    expect(t.rows.map((r) => r.value_numeric)).not.toContain("77");
    expect(t.rows.map((r) => r.value_numeric)).not.toContain("99.99");
    expect(t.rows).toHaveLength(6 + UNSPECIFIED_READINGS);

    // studio_machine_id: BLANK for a reading on the unspecified placeholder (which the archive does not carry), and still the real id, unchanged, for a
    // reading on a registered machine (the control: the blank rule must not be a blanket blanking of the column).
    const realMachineIds = (
      await adminQuery(`select id from public.studio_machines where studio_id=$1 and not is_unspecified`, [studioA.studioId])
    ).rows.map((r) => r.id as string);
    expect(realMachineIds).toHaveLength(1);
    const unspecifiedRows = t.rows.filter((r) => r.session_block_id === blockU);
    expect(unspecifiedRows).toHaveLength(UNSPECIFIED_READINGS);
    for (const r of unspecifiedRows) expect(r.studio_machine_id, "an unspecified-machine reading has no machine id").toBe("");
    expect(unspecifiedRows.find((r) => r.field_key === "snap_count")!.value_numeric).toBe("3");
    expect(JSON.stringify(t.rows)).not.toContain(unspecifiedMachineId);
    for (const r of own) expect(r.studio_machine_id, "a registered machine keeps its id").toBe(realMachineIds[0]);

    // the source-count check ran and matched
    const manifest = JSON.parse(await archive.files["manifest.json"].async("string")) as { source_count_checks: Array<Record<string, unknown>> };
    const check = manifest.source_count_checks.find((c) => c.table === "treatment_setup_readings")!;
    expect(check).toMatchObject({ status: "matched", exported_rows: 6 + UNSPECIFIED_READINGS, studio_row_count: 6 + UNSPECIFIED_READINGS });
  });
});

describe("the source-count check is real for this file (negative control)", () => {
  it("one reading row lost on the way is caught: the export is REFUSED and names the table, with no archive", async () => {
    tamper.dropLastReadingRow = true;
    try {
      await signInAsStudioAOwner();
      const result = await runExport();
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("treatment_setup_readings returned 11 rows but the studio holds 12");
      expect(result.error).toContain("No partial export was produced");
    } finally {
      tamper.dropLastReadingRow = false;
    }
  });
});
