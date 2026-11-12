import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG, catalogByKey, enforcementOf } from "@/lib/permissions/catalog";

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

  it("move refuses the WHOLE action when the reassign check cannot be read (never continues as a time-only move)", () => {
    const b = body(read("app/(app)/calendar/move-appointment-actions.ts"), "moveAppointmentAction");
    const ask = b.indexOf('"appt.reassign"');
    const refuse = b.search(/reassignDecision\.engine === null && !reassignDecision\.engineAbsent/);
    expect(refuse, "unreadable reassign check must refuse").toBeGreaterThan(ask);
    expect(b.slice(refuse, refuse + 260)).toMatch(/return \{ ok: false/);
    expect(refuse).toBeLessThan(b.indexOf("move_or_reassign_appointment"));
  });

  it("clin.view_records gates every treatment-data read path found in the audit (Codex #1335)", () => {
    const gated = [
      "app/(app)/clients/[id]/page.tsx",
      "app/(app)/clients/[id]/sessions/new/page.tsx",
      "app/(app)/clients/[id]/clinical-notes/print/page.tsx",
      "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx",
      "app/(app)/calendar/[id]/page.tsx",
      "app/(app)/global-search-actions.ts",
    ];
    for (const f of gated) expect(read(f), f).toContain('"clin.view_records"');
    // The edit form reads the client row only: it opts out of the sessions read instead of asking.
    expect(read("app/(app)/clients/[id]/edit/page.tsx")).toContain("includeSessions: false");
    // getClientById reads sessions only when the caller says it may.
    expect(read("lib/supabase/queries.ts")).toMatch(/includeSessions/);
  });

  it("the sessions page asks clin.view_aftercare before it renders the aftercare send panel", () => {
    const s = read("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx");
    expect(s).toContain('"clin.view_aftercare"');
    expect(s.indexOf("canViewAftercare &&")).toBeGreaterThan(-1);
    expect(s.indexOf("canViewAftercare &&")).toBeLessThan(s.indexOf("<PostcareSection"));
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

  it("every availability action asks an avail.* key (owner floor stays), and the key follows the target scope", () => {
    const src = read("app/(app)/settings/availability/actions.ts");
    const names = [...src.matchAll(/export async function (\w+Action)\(/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(15);
    for (const n of names) {
      const b = body(src, n);
      expect(/assertAvailabilityKey\(|assertOwner\(\)/.test(b), `${n} must reach an avail.* check`).toBe(true);
    }
    expect(src).toContain('"avail.manage_studio_hours"');
    expect(src).toContain('"avail.manage_own"');
    expect(src).toContain('"avail.manage_others"');
    expect(src).toMatch(/practitioner\.role !== "owner"/); // the floor is unchanged
    for (const k of ["avail.manage_own", "avail.manage_others", "avail.manage_studio_hours"]) expect(catalogByKey.has(k), k).toBe(true);
  });

  it("RC-4: with clin.view_photos off the photos page lists nothing (no rows, dates, counts) and shows one neutral line", () => {
    const s = read("app/(app)/clients/[id]/images/page.tsx");
    const ask = s.indexOf('"clin.view_photos"');
    const neutral = s.indexOf("Photos are not available to your role.");
    expect(ask).toBeGreaterThan(-1);
    expect(neutral).toBeGreaterThan(ask);
    // the key is asked, and the neutral page returned, BEFORE the photo rows are read
    expect(s.indexOf('.from("treatment_images")')).toBeGreaterThan(neutral);
    expect(s.slice(ask, neutral)).toMatch(/if \(!canViewPhotos\) \{\s*return \(/);
  });

  describe("repository-wide: every treatment-images signing site is behind a permission check (Privacy X2)", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        if (n === "node_modules" || n === ".next") return [];
        return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
      });
    const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const sites = [...walk("app"), ...walk("lib")].filter((f) => /createSignedUrl\(/.test(code(read(f))));

    it("finds exactly the known signing sites, so a new one cannot be added without this test noticing", () => {
      expect(sites.sort()).toEqual([
        "app/(app)/clients/[id]/images/page.tsx",
        "app/(app)/clients/[id]/images/sign-treatment-image.ts",
        "app/(app)/clients/[id]/sessions/[sessionId]/session-photos.ts",
        "lib/images/client-portrait.ts",
      ]);
    });

    it("each asks clin.view_photos, or (ID portraits, DN-24) observes owner-only, before it signs", () => {
      for (const f of sites) {
        const s = code(read(f));
        const sign = s.search(/createSignedUrl\(/);
        const guard = f === "lib/images/client-portrait.ts" ? s.indexOf("observePortraitOwnerOnly(input.studioId)") : s.indexOf('"clin.view_photos"');
        expect(guard, f).toBeGreaterThan(-1);
        expect(guard, f).toBeLessThan(sign);
      }
    });
  });

  it("the catalog's enforcement flag equals the keys the app really asks (Privacy X3): no key is marked enforced that nothing asks, none asked that is not marked", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        if (n === "node_modules" || n === ".next") return [];
        return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
      });
    const asked = new Set<string>();
    for (const f of [...walk("app"), ...walk("lib")]) {
      if (f.startsWith("lib/permissions/")) continue;
      const s = read(f);
      for (const m of s.matchAll(/requirePermission\(\s*[^,]+,\s*[^,]+,\s*"([a-z_]+\.[a-z_]+)"/g)) asked.add(m[1]!);
    }
    // availability actions pick one of three keys through assertAvailabilityKey
    for (const m of read("app/(app)/settings/availability/actions.ts").matchAll(/"(avail\.manage_[a-z_]+)"/g)) asked.add(m[1]!);
    const marked = new Set(CATALOG.filter((d) => (d as { enforcement?: string }).enforcement).map((d) => d.key));
    // NAMED carve-out (OPS/Team, 12 Nov): clin.view_intake_status is asked by the I2 readers (the 0334 projection serves it) but stays not_yet in the
    // catalog, because the enforced flag is tied to release state (0287: every enforced key is in the release seed) and the permission-activation hold
    // stands. The flip commit removes this carve-out. It FAILS once the key is released (seeded), so it cannot outlive the hold.
    const ASKED_AHEAD_OF_FLIP = ["clin.view_intake_status", "client.view_personal_notes", "client.view_budget"]; // the last two: 0335 readers, same hold
    const seedKeys = [...read("supabase/migrations/0287_roles_permission_engine.sql").replace(/^\s*--.*$/gm, "").matchAll(/\('([a-z_.]+)', null, '[^']+', '(?:full|narrow)'\)/g)].map((m) => m[1]!);
    for (const k of ASKED_AHEAD_OF_FLIP) {
      expect(asked, `${k} is no longer asked: remove it from ASKED_AHEAD_OF_FLIP`).toContain(k);
      expect(enforcementOf(k)).toBe("not_yet");
      expect(seedKeys, `${k} is now released: mark it enforced in the catalog and remove it from ASKED_AHEAD_OF_FLIP`).not.toContain(k);
      asked.delete(k);
    }
    expect([...asked].sort()).toEqual([...marked].sort());
    for (const k of asked) expect(["enforced", "deny_only", "observe"]).toContain(enforcementOf(k));
    expect(enforcementOf("appt.complete")).toBe("observe"); // asked, logged, never blocks
  });

  describe("enforced means BOTH directions take effect; deny_only means a legacy check still stands in front (OPS delta review RE-1/RG-2/F1)", () => {
    // Each deny_only key, and the legacy check in the source that makes widening it inert today.
    const LEGACY: Record<string, { file: string; fn?: string; marker: RegExp; why: string }> = {
      "appt.book": { file: "app/(app)/calendar/actions.ts", fn: "bookAppointmentForClientAction", marker: /getCurrentPractitionerWithStudio/, why: "practitioner-only action path" },
      "appt.move": { file: "app/(app)/calendar/move-appointment-actions.ts", fn: "moveAppointmentAction", marker: /getCurrentPractitionerWithStudio/, why: "practitioner-only action path" },
      "appt.reassign": { file: "app/(app)/calendar/move-appointment-actions.ts", fn: "moveAppointmentAction", marker: /practitioner\.role === "owner"/, why: "owner-only reassign" },
      "avail.manage_own": { file: "app/(app)/settings/availability/actions.ts", marker: /Only studio owners can change availability\./, why: "owner-only availability floor" },
      "avail.manage_others": { file: "app/(app)/settings/availability/actions.ts", marker: /Only studio owners can change availability\./, why: "owner-only availability floor" },
      "avail.manage_studio_hours": { file: "app/(app)/settings/availability/actions.ts", marker: /Only studio owners can change availability\./, why: "owner-only availability floor" },
    };

    it("the catalog's deny_only keys are exactly the keys with a legacy check in front, and no enforced key is one of them", () => {
      const denyOnly = CATALOG.filter((d) => enforcementOf(d.key) === "deny_only").map((d) => d.key).sort();
      expect(denyOnly).toEqual(Object.keys(LEGACY).sort());
      for (const d of CATALOG.filter((x) => enforcementOf(x.key) === "enforced")) expect(LEGACY[d.key], `${d.key} is enforced but has a legacy floor`).toBeUndefined();
    });

    it("the legacy check really is in the source ahead of the key (so deny_only is true, not a guess)", () => {
      for (const [key, { file, fn, marker }] of Object.entries(LEGACY)) {
        const src = fn ? body(read(file), fn) : read(file);
        const ask = src.indexOf(`"${key}"`);
        expect(ask, key).toBeGreaterThan(-1);
        if (fn) expect(src.slice(0, ask), `${key}: legacy check precedes the key`).toMatch(marker);
        else expect(src, key).toMatch(marker);
      }
    });

    it("every enforced key's snapshot is already the widest the key can be given, or its widening reaches a real path", () => {
      // The other direction: an enforced key must not be one whose action path is closed to the roles a widening would add.
      for (const k of ["appt.cancel", "appt.mark_no_show", "appt.edit_notes", "clin.view_records", "clin.view_photos", "clin.view_intake", "clin.view_aftercare"]) {
        expect(enforcementOf(k), k).toBe("enforced");
        expect(LEGACY[k], k).toBeUndefined();
      }
    });
  });
});
