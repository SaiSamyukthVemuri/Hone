"use server";

import JSZip from "jszip";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

export type ExportResult =
  | { ok: true; filename: string; base64: string }
  | { ok: false; error: string };

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s: string;
  if (typeof value === "string") {
    s = value;
  } else if (typeof value === "object") {
    s = JSON.stringify(value);
  } else {
    s = String(value);
  }
  // Quote whenever the value contains a comma, quote, CR, or LF.
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<Record<string, unknown>>,
): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvCell(row[h])).join(","));
  }
  // Trailing newline so downstream tools recognize the last row consistently.
  return `${lines.join("\n")}\n`;
}

function slugify(s: string): string {
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "studio";
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function exportStudioDataAction(): Promise<ExportResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot export data." };
  }

  const supabase = await createClient();

  // electrolysis_entries and laser_entries don't carry studio_id directly;
  // RLS scopes them through the parent session, so a plain select is safe.
  const [
    clientsRes,
    sessionsRes,
    electRes,
    laserRes,
    practitionersRes,
    pricingRes,
  ] = await Promise.all([
    supabase
      .from("clients")
      .select(
        "id, name, pronouns, date_of_birth, fitzpatrick_type, allergies, skin_notes, emergency_contact_name, emergency_contact_phone, email, phone, created_at",
      )
      .eq("studio_id", studio.id)
      .order("name", { ascending: true }),
    supabase
      .from("sessions")
      .select(
        "id, client_id, practitioner_id, performed_by_practitioner_id, modality, started_at, ended_at, price_paid_cents, session_notes, created_at",
      )
      .eq("studio_id", studio.id)
      .is("deleted_at", null)
      .order("started_at", { ascending: false }),
    supabase
      .from("electrolysis_entries")
      .select(
        "id, session_id, area, probe_size, probe_lot_id, mode, intensity, duration_seconds, pulse_count, comments, created_at",
      )
      .order("created_at", { ascending: false }),
    supabase
      .from("laser_entries")
      .select(
        "id, session_id, zone, session_number, equipment_params, observation_notes, created_at",
      )
      .order("created_at", { ascending: false }),
    supabase
      .from("practitioners")
      .select("id, display_name, email, role, active, created_at")
      .eq("studio_id", studio.id)
      .eq("active", true)
      .order("display_name", { ascending: true }),
    supabase
      .from("client_pricing")
      .select("id, client_id, service_name, price_cents, notes, effective_from")
      .eq("studio_id", studio.id)
      .order("effective_from", { ascending: false }),
  ]);

  for (const r of [
    clientsRes,
    sessionsRes,
    electRes,
    laserRes,
    practitionersRes,
    pricingRes,
  ]) {
    if (r.error) {
      return {
        ok: false,
        error: `Failed to load data for export: ${r.error.message}`,
      };
    }
  }

  // Entries are fetched in parallel with sessions, so they may contain rows
  // belonging to soft-deleted sessions. Filter them out using the set of
  // active session IDs returned above.
  const activeSessionIds = new Set(
    ((sessionsRes.data ?? []) as { id: string }[]).map((s) => s.id),
  );
  const filteredElectrolysis = (
    (electRes.data ?? []) as { session_id: string }[]
  ).filter((e) => activeSessionIds.has(e.session_id));
  const filteredLaser = (
    (laserRes.data ?? []) as { session_id: string }[]
  ).filter((e) => activeSessionIds.has(e.session_id));

  // Flatten the laser equipment_params JSON into top-level CSV columns so
  // spreadsheets show fluence / pulse_width / spot_size as plain fields.
  type LaserRow = {
    id: string;
    session_id: string;
    zone: string;
    session_number: number | null;
    equipment_params: Record<string, unknown> | null;
    observation_notes: string | null;
    created_at: string;
  };
  const laserRows = (filteredLaser as unknown as LaserRow[]).map((e) => {
    const params = (e.equipment_params ?? {}) as Record<string, unknown>;
    return {
      id: e.id,
      session_id: e.session_id,
      zone: e.zone,
      treatment_number: e.session_number,
      fluence: typeof params.fluence === "string" ? params.fluence : null,
      pulse_width:
        typeof params.pulse_width === "string" ? params.pulse_width : null,
      spot_size:
        typeof params.spot_size === "string" ? params.spot_size : null,
      observation_notes: e.observation_notes,
      created_at: e.created_at,
    };
  });

  const zip = new JSZip();

  zip.file(
    "clients.csv",
    rowsToCsv(
      [
        "id",
        "name",
        "pronouns",
        "date_of_birth",
        "fitzpatrick_type",
        "allergies",
        "skin_notes",
        "emergency_contact_name",
        "emergency_contact_phone",
        "email",
        "phone",
        "created_at",
      ],
      clientsRes.data ?? [],
    ),
  );

  zip.file(
    "sessions.csv",
    rowsToCsv(
      [
        "id",
        "client_id",
        "practitioner_id",
        "performed_by_practitioner_id",
        "modality",
        "started_at",
        "ended_at",
        "price_paid_cents",
        "session_notes",
        "created_at",
      ],
      sessionsRes.data ?? [],
    ),
  );

  zip.file(
    "electrolysis_entries.csv",
    rowsToCsv(
      [
        "id",
        "session_id",
        "area",
        "probe_size",
        "probe_lot_id",
        "mode",
        "intensity",
        "duration_seconds",
        "pulse_count",
        "comments",
        "created_at",
      ],
      filteredElectrolysis as unknown as Record<string, unknown>[],
    ),
  );

  zip.file(
    "laser_entries.csv",
    rowsToCsv(
      [
        "id",
        "session_id",
        "zone",
        "treatment_number",
        "fluence",
        "pulse_width",
        "spot_size",
        "observation_notes",
        "created_at",
      ],
      laserRows,
    ),
  );

  zip.file(
    "practitioners.csv",
    rowsToCsv(
      ["id", "display_name", "email", "role", "active", "created_at"],
      practitionersRes.data ?? [],
    ),
  );

  zip.file(
    "client_pricing.csv",
    rowsToCsv(
      ["id", "client_id", "service_name", "price_cents", "notes", "effective_from"],
      pricingRes.data ?? [],
    ),
  );

  const generatedAt = new Date().toISOString();
  const readme = `Hone Data Export
Generated: ${generatedAt}
Studio: ${studio.name}

This export contains all client records, sessions, and entries for your studio.

Files included:
- clients.csv: Client master list with names, contact info, allergies, skin notes, Fitzpatrick type, emergency contacts.
- sessions.csv: One row per session: client, performer, started_at, ended_at, price_paid_cents, session_notes.
- electrolysis_entries.csv: Every electrolysis entry with probe, mode, intensity, duration, pulse count, area, comments.
- laser_entries.csv: Every laser entry with zone, fluence, pulse width, treatment number, observations.
- practitioners.csv: Active practitioners at your studio.
- client_pricing.csv: Per-client custom pricing.

Your data is yours. This export can be opened in Excel, Numbers, Google Sheets, or any spreadsheet tool. If you ever leave Hone, your records leave with you.

Saltkiln Inc.
hone.care
hello@hone.care
`;

  zip.file("README.txt", readme);

  const bytes = await zip.generateAsync({ type: "uint8array" });
  const base64 = Buffer.from(bytes).toString("base64");
  const filename = `hone-export-${slugify(studio.name)}-${todayStamp()}.zip`;

  return { ok: true, filename, base64 };
}
