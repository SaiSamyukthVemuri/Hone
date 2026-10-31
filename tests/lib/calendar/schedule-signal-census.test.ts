import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// HON-48 Q7 final change-trigger list (0271), as a census that FAILS when the calendar
// starts showing something the signal does not announce.
//
// Two censuses, both derived from the code rather than written from memory:
//  1. TABLES: every table the calendar page reads (derived from the query helpers the
//     page imports) must be classified: `triggers` (a 0271 trigger announces it),
//     `fallback` (the 60 s / focus refresh carries it) or `not_visible`. A new table
//     read by the page fails here until Sam's list is extended.
//  2. COLUMNS: for each triggered table, every column of its row type must be classified.
//     A column the calendar or drawer READS that is neither a trigger column nor
//     explicitly explained fails: that is a schedule-visible column the trigger misses.

const read = (p: string) => readFileSync(p, "utf8");
const migration = read("supabase/migrations/0271_schedule_change_signal.sql");
const code = migration.replace(/^\s*--.*$/gm, "");

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

// ---- 1. tables ------------------------------------------------------------------------
type Where = "triggers" | "fallback" | "not_visible";
const TABLES: Record<string, { where: Where; why: string }> = {
  appointments: { where: "triggers", why: "the grid" },
  studio_timed_blocks: { where: "triggers", why: "blocked time on the grid" },
  studio_blockouts: { where: "triggers", why: "whole-day closures on the grid and month" },
  studio_recurring_break_occurrences: { where: "triggers", why: "recurring breaks on the grid" },
  studio_availability_default: { where: "fallback", why: "open-hours tint; an owner settings edit, rare" },
  studio_availability_overrides: { where: "fallback", why: "per-date hours tint; an owner settings edit, rare" },
  practitioners: { where: "fallback", why: "column names, colours, active; an owner edit, rare" },
  services: { where: "fallback", why: "service names and colours; an owner edit, rare" },
  clients: { where: "fallback", why: "client display names; not a schedule change" },
};

function tablesReadByCalendarPage(): string[] {
  const page = read("app/(app)/calendar/page.tsx");
  const imported = new Set<string>();
  for (const m of page.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@\/lib\/(?:booking|supabase)\/queries"/g)) {
    for (const n of m[1].split(",")) imported.add(n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]);
  }
  const sources = [read("lib/booking/queries.ts"), read("lib/supabase/queries.ts")];
  const tables = new Set<string>();
  for (const name of imported) {
    if (!/^get[A-Z]/.test(name)) continue;
    for (const src of sources) {
      const start = src.search(new RegExp(`export async function ${name}\\b`));
      if (start < 0) continue;
      const rest = src.slice(start + 1);
      const end = rest.search(/\nexport (?:async )?function /);
      const body = end < 0 ? rest : rest.slice(0, end);
      for (const t of body.matchAll(/\.from\("([a-z_]+)"\)/g)) tables.add(t[1]);
    }
  }
  return [...tables].sort();
}

describe("tables the calendar page reads", () => {
  const read_ = tablesReadByCalendarPage();
  it("finds the tables (the derivation itself is not vacuous)", () => {
    for (const t of ["appointments", "studio_timed_blocks", "studio_blockouts", "studio_recurring_break_occurrences"]) {
      expect(read_).toContain(t);
    }
  });
  it("every table the page reads is classified: triggers, fallback or not visible", () => {
    const unclassified = read_.filter((t) => !(t in TABLES));
    expect(unclassified, `classify in Sam's final trigger list: ${unclassified.join(", ")}`).toEqual([]);
  });
  it("every table classified `triggers` has all three statement-level triggers in 0271", () => {
    for (const [t, c] of Object.entries(TABLES).filter(([, v]) => v.where === "triggers")) {
      expect(read_, `${t} is not read by the page any more`).toContain(t);
      for (const [kind, ev] of [["ins", "insert"], ["upd", "update"], ["del", "delete"]] as const) {
        expect(code, `${t} ${kind}`).toMatch(
          new RegExp(`create trigger ${t}_schedule_signal_${kind}_trg\\s+after ${ev} on public\\.${t}\\s+referencing [^;]*for each statement execute function public\\.emit_schedule_signal\\(`),
        );
      }
      expect(c.why.length).toBeGreaterThan(0);
    }
  });
  it("no trigger exists for a table the list says is fallback or not visible", () => {
    const triggered = [...code.matchAll(/create trigger (\w+?)_schedule_signal_(?:ins|upd|del)_trg/g)].map((m) => m[1]);
    for (const t of new Set(triggered)) expect(TABLES[t]?.where, t).toBe("triggers");
  });
});

// ---- 2. columns -----------------------------------------------------------------------
type Col = "trigger" | "bookkeeping" | "derived" | "immutable" | "not_visible";
const WHY = (c: Col, why: string) => ({ c, why });

const ROW_TYPES: Record<string, { type: string; cols: Record<string, { c: Col; why: string }> }> = {
  appointments: {
    type: "Appointment",
    cols: {
      id: WHY("immutable", "identity"), studio_id: WHY("immutable", "scope"), created_at: WHY("immutable", "set once"),
      practitioner_id: WHY("trigger", "column"), client_id: WHY("trigger", "card name"), service_id: WHY("trigger", "card service and colour"),
      starts_at: WHY("trigger", "position"), ends_at: WHY("trigger", "height"), duration_minutes: WHY("trigger", "height"),
      status: WHY("trigger", "cancelled/completed/no-show state"), notes: WHY("trigger", "shown in the drawer"),
      blocked_ends_at: WHY("trigger", "buffer shading"), buffer_minutes_snapshot: WHY("trigger", "buffer shading"),
      updated_at: WHY("derived", "moves only with a listed column (appointments_set_updated_at_trg)"),
      cancellation_reason: WHY("derived", "written together with status"), cancelled_at: WHY("derived", "written together with status"),
      cancelled_by: WHY("derived", "written together with status"), cancelled_by_practitioner_id: WHY("derived", "written together with status"),
      cancelled_by_receptionist_id: WHY("derived", "written together with status"), cancellation_kind: WHY("derived", "written together with status"),
      capacity_enabled: WHY("immutable", "snapshot at creation"), booked_outside_availability: WHY("immutable", "set at creation"),
      created_by_practitioner_id: WHY("immutable", "set at creation"), created_by_receptionist_id: WHY("immutable", "set at creation"),
      outside_availability_authorized_by_practitioner_id: WHY("immutable", "set at creation"),
      outside_availability_authorized_role: WHY("immutable", "set at creation"), outside_availability_authorized_at: WHY("immutable", "set at creation"),
      rescheduled_from_appointment_id: WHY("derived", "written together with starts_at"), rescheduled_to_appointment_id: WHY("derived", "written together with status"),
      referral_source: WHY("immutable", "set at creation"),
      arrived_at: WHY("not_visible", "0268 check-in is held (the only column 0268 adds; the actor goes to the audit trail, not a column); when 0268 ships and the calendar shows it, a NEW migration adds arrived_at to the update-trigger list - 0271 is never edited after apply"),
      sync_version: WHY("bookkeeping", "Google sync version"), cancellation_token_hash: WHY("not_visible", "never rendered"),
    },
  },
  studio_timed_blocks: {
    type: "StudioTimedBlock",
    cols: {
      id: WHY("immutable", "identity"), studio_id: WHY("immutable", "scope"), created_at: WHY("immutable", "set once"), created_by: WHY("immutable", "set once"),
      starts_at: WHY("trigger", "position"), ends_at: WHY("trigger", "height"), category: WHY("trigger", "label and glyph"),
      practitioner_id: WHY("trigger", "column"), updated_at: WHY("derived", "set by the owner edit together with a listed column"),
      private_note: WHY("trigger", "DayColumn and MobileDayTimeline show it as the block's tooltip (found by this census)"),
    },
  },
  studio_blockouts: {
    type: "StudioBlockout",
    cols: {
      id: WHY("immutable", "identity"), studio_id: WHY("immutable", "scope"), created_at: WHY("immutable", "set once"),
      starts_on: WHY("trigger", "range"), ends_on: WHY("trigger", "range"), reason: WHY("trigger", "month-blocked.ts shows it as the full-day label (found by this census)"),
    },
  },
  studio_recurring_break_occurrences: {
    type: "StudioRecurringBreakOccurrence",
    cols: {
      id: WHY("immutable", "identity"), studio_id: WHY("immutable", "scope"), created_at: WHY("immutable", "set once"), rule_id: WHY("immutable", "set at materialisation"),
      occurrence_date: WHY("derived", "written together with starts_at"), starts_at: WHY("trigger", "position"), ends_at: WHY("trigger", "height"),
      practitioner_id: WHY("derived", "a scope change rematerialises the rows (delete and insert)"),
    },
  },
};

// Mail, SMS, postcare and intake-reminder bookkeeping: written by cron and workers, and the
// reason the UPDATE trigger is column-scoped. The UI-read scan below still fails if the
// calendar ever starts reading one, so this rule cannot hide a schedule-visible column.
const BOOKKEEPING = /_(sent_at|send_attempts|claimed_at|failed_at|last_error|last_attempt_at)$/;
function classOf(spec: { cols: Record<string, { c: Col; why: string }> }, col: string): Col | undefined {
  return spec.cols[col]?.c ?? (BOOKKEEPING.test(col) ? "bookkeeping" : undefined);
}

function typeColumns(typeName: string): string[] {
  const src = read("lib/types/database.ts");
  const start = src.indexOf(`export type ${typeName} = {`);
  expect(start, `type ${typeName}`).toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf("\n};", start));
  return [...body.matchAll(/^ {2}([a-z_0-9]+)\??:/gm)].map((m) => m[1]);
}

function triggerColumns(table: string): string[] {
  const m = code.match(new RegExp(`create trigger ${table}_schedule_signal_upd_trg[\\s\\S]*?emit_schedule_signal\\(([^)]*)\\)`));
  expect(m, `${table} update trigger`).toBeTruthy();
  return [...m![1].matchAll(/'([a-z_0-9]+)'/g)].map((x) => x[1]);
}

const UI_FILES = [
  ...files("app/(app)/calendar"),
  ...files("lib/calendar"),
  ...files("components").filter((p) => /calendar|drawer/i.test(p)),
].filter(
  (p) =>
    !p.endsWith("schedule-signal.ts") &&
    !p.endsWith("schedule-fingerprint.ts") &&
    // The appointment detail page renders when it is opened; its message-status chips
    // (sent_at / send_attempts) are carried by that load and by the fallback, not by the
    // grid signal. Everything the GRID and the drawers read is held to the census.
    !p.includes("[id]/page.tsx"),
);
const UI_TEXT = UI_FILES.map((p) => read(p)).join("\n");

describe.each(Object.entries(ROW_TYPES))("columns of %s", (table, spec) => {
  const cols = typeColumns(spec.type);
  const trig = triggerColumns(table);

  it("derives a non-trivial column set from the row type", () => {
    expect(cols.length).toBeGreaterThan(5);
    expect(trig.length).toBeGreaterThan(1);
  });

  it("every column of the row type is classified", () => {
    const missing = cols.filter((c) => classOf(spec, c) === undefined);
    expect(missing, `classify as trigger / bookkeeping / derived / immutable / not_visible: ${missing.join(", ")}`).toEqual([]);
  });

  it("the trigger column list is exactly the columns classified `trigger`", () => {
    const declared = cols.filter((c) => classOf(spec, c) === "trigger").sort();
    expect([...trig].sort()).toEqual(declared);
    for (const c of trig) expect(cols, `${c} is not a column of ${spec.type}`).toContain(c);
  });

  it("a column the calendar or drawer READS and the trigger misses is a schedule-visible column: it must be explained as derived or immutable", () => {
    const readButMissed: string[] = [];
    for (const c of cols) {
      if (trig.includes(c)) continue;
      const cls = classOf(spec, c);
      if (cls === "derived" || cls === "immutable") continue;
      const reads = new RegExp(`(?:\\.|\\?\\.|\\[["'])${c}\\b|["']${c}["']\\s*:`).test(UI_TEXT);
      if (reads && cls !== "bookkeeping" && cls !== "not_visible") readButMissed.push(c);
      // A column declared bookkeeping / not_visible must really not be read by the calendar UI.
      if (reads && (cls === "bookkeeping" || cls === "not_visible")) readButMissed.push(`${c} (declared ${cls} but read by the calendar UI)`);
    }
    expect(readButMissed, "add to the UPDATE column list in 0271 or explain why a change here cannot move the grid").toEqual([]);
  });
});
