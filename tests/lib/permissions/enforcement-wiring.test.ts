import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { catalogByKey } from "@/lib/permissions/catalog";

const read = (p: string) => readFileSync(p, "utf8");
const body = (src: string, fn: string) => {
  const i = src.indexOf(`export async function ${fn}(`);
  expect(i, fn).toBeGreaterThan(-1);
  const j = src.indexOf("\nexport async function ", i + 10);
  return src.slice(i, j === -1 ? undefined : j);
};

// Each protected path: the key must be asked BEFORE the first privileged effect (service-role client, RPC, storage signing).
const FIRST_EFFECT = /createAdminClient\(\)|admin\.rpc\(|createSignedUrl|admin\.storage|\.rpc\(/;

const ACTIONS: Array<[file: string, fn: string, key: string]> = [
  ["app/(app)/calendar/actions.ts", "bookAppointmentForClientAction", "appt.book"],
  ["app/(app)/calendar/actions.ts", "cancelAppointmentAction", "appt.cancel"],
  ["app/(app)/calendar/actions.ts", "markAppointmentNoShowAction", "appt.mark_no_show"],
  ["app/(app)/calendar/actions.ts", "markAppointmentCompleteAction", "appt.complete"],
  ["app/(app)/calendar/move-appointment-actions.ts", "moveAppointmentAction", "appt.move"],
  ["app/(app)/calendar/appointment-repair-actions.ts", "setAppointmentNotesAction", "appt.edit_notes"],
];

describe("enforcement wiring: the key is asked before any privileged effect", () => {
  for (const [file, fn, key] of ACTIONS) {
    it(`${fn} asks ${key} first`, () => {
      const b = body(read(file), fn);
      const ask = b.indexOf(`"${key}"`);
      expect(ask, `${fn} must call requirePermission with ${key}`).toBeGreaterThan(-1);
      expect(b.lastIndexOf("requirePermission(", ask)).toBeGreaterThan(-1);
      // move reads the appointment with the studio-scoped admin client first (needed to decide scope); its effect is the move command.
      const effect = fn === "moveAppointmentAction" ? b.indexOf("move_or_reassign_appointment") : b.search(FIRST_EFFECT);
      expect(ask, `${key} is asked after a privileged effect`).toBeLessThan(effect === -1 ? Infinity : effect);
    });
  }

  it("move also asks appt.reassign before it honours a reassignment target", () => {
    const b = body(read("app/(app)/calendar/move-appointment-actions.ts"), "moveAppointmentAction");
    expect(b).toContain('"appt.reassign"');
    expect(b.indexOf('"appt.reassign"')).toBeLessThan(b.indexOf("move_or_reassign_appointment"));
  });

  it("every storage signing site is behind clin.view_photos (the URL is not issued when off)", () => {
    const sites: Array<[string, RegExp]> = [
      ["app/(app)/clients/[id]/images/sign-treatment-image.ts", /createSignedUrl/],
      ["app/(app)/clients/[id]/sessions/[sessionId]/session-photos.ts", /createSignedUrl/],
      ["app/(app)/clients/[id]/images/page.tsx", /createSignedUrl/],
    ];
    for (const [file, sign] of sites) {
      const s = read(file);
      const ask = s.indexOf('"clin.view_photos"');
      expect(ask, file).toBeGreaterThan(-1);
      expect(ask, file).toBeLessThan(s.search(sign));
    }
    // the page gates every signing branch on the answer, not just the first
    expect(read("app/(app)/clients/[id]/images/page.tsx")).toMatch(/canViewPhotos && validateTreatmentImagePath/);
  });

  it("pages for the chart, intake answers and aftercare are gated", () => {
    expect(read("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx")).toMatch(/"clin\.view_records"[\s\S]{0,120}\)\.allowed\) notFound\(\)/);
    expect(read("app/(app)/clients/[id]/intake/page.tsx")).toMatch(/"clin\.view_intake"[\s\S]{0,120}\)\.allowed\) notFound\(\)/);
    expect(read("app/(app)/calendar/[id]/page.tsx")).toMatch(/canViewAftercare[\s\S]*data\.client && canViewAftercare/);
  });

  it("every wired key is a real catalog key", () => {
    for (const [, , key] of ACTIONS) expect(catalogByKey.has(key), key).toBe(true);
    for (const k of ["appt.reassign", "clin.view_photos", "clin.view_records", "clin.view_intake", "clin.view_aftercare"]) expect(catalogByKey.has(k), k).toBe(true);
  });
});
