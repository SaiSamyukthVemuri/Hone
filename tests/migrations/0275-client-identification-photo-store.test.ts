import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, migrationVersions } from "./helpers/migration-state";
import { grantedRoles, revokedRoles, REQUIRED_REVOKES, BLANKET_FUNCTION_GRANT } from "./helpers/grant-posture";

// 0275 · FETT photos (HON-43, P2): a separate private client IDENTIFICATION-PHOTO
// store. Source contract only; behaviour (default OFF, consent, access, deletion,
// the closed 0231 bypass) is proved against a real database in
// tests/db/client-id-photo.db.test.ts.

const VERSION = "0275";
const FILE = "supabase/migrations/0275_client_identification_photo_store.sql";
const sql = readFileSync(FILE, "utf8");
/** Executable SQL only: line comments stripped before block comments. */
const EXECUTABLE = sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
/** Top level only (function bodies blanked). */
const TOP_LEVEL = EXECUTABLE.replace(/\$\$[\s\S]*?\$\$/g, " <body> ");

/** Authenticated commands and the RLS predicate: revoked from all four, granted to authenticated only. */
const AUTHENTICATED: Array<[string, string]> = [
  ["client_id_photo_can_read", "uuid, uuid"],
  ["client_id_photo_wording_current", "uuid"],
  ["client_id_photo_enabled", "uuid"],
  ["record_client_id_photo_consent", "uuid, text, text, text, text"],
  ["withdraw_client_id_photo_consent", "uuid"],
  ["set_client_id_photo", "uuid, text, integer, integer, integer"],
  ["remove_client_id_photo", "uuid"],
  ["reserve_client_id_photo_path", "uuid"],
];
/** C2: the deletion queue is drained by the SERVER only: revoked from all four, granted to service_role only. */
const SERVICE_ROLE_ONLY: Array<[string, string]> = [
  ["pending_client_id_photo_object_deletions", "integer"],
  ["ack_client_id_photo_object_deletion", "text"],
];
/** Granted to NOBODY: internal helpers, operator commands and trigger functions. */
const NOBODY: Array<[string, string]> = [
  ["client_id_photo_actor", "uuid"],
  ["client_id_photo_switch_on", "uuid"],
  ["client_id_photo_consent_granted", "uuid, uuid"],
  ["set_client_id_photo_enabled", "uuid, boolean, text"],
  ["approve_client_id_photo_wording", "text"],
  ["client_id_photo_immutable", ""],
  ["client_id_photo_wording_guard", ""],
  ["studio_client_id_photo_switch_log_write", ""],
  ["client_id_photo_queue_object", ""],
  ["client_id_photo_on_client_archive", ""],
  ["clients_portrait_pointer_frozen", ""],
  // decision 10: the 0231 setter is retired
  ["set_client_portrait", "uuid, uuid, uuid"],
];

const TABLES = [
  "client_id_photo_wording_versions",
  "studio_client_id_photo_settings",
  "studio_client_id_photo_switch_log",
  "client_id_photo_consents",
  "client_id_photos",
  "client_id_photo_audit",
  "client_id_photo_pending_object_deletions",
];

/** Every function this migration creates, with its body. */
function createdFunctions(): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = /create or replace function public\.(\w+)\([\s\S]*?\$\$([\s\S]*?)\$\$;/g;
  for (const m of EXECUTABLE.matchAll(re)) out.push({ name: m[1], body: m[2] });
  return out;
}

describe("0275 sits correctly in the migration sequence", () => {
  it("is present exactly once, above the migrations it builds on", () => {
    // NO isRepoMax pin: it is a claim about the tree, and goes red in composition.
    expect(countVersion(VERSION)).toBe(1);
    const versions = migrationVersions();
    expect(versions, "clients_id_studio_id_unique").toContain("0001");
    expect(versions, "0231 pointer and setter").toContain("0231");
  });
});

describe("0275's transaction and shape", () => {
  it("opens its own transaction and arms lock_timeout inside it", () => {
    expect(sql).toMatch(/^begin;/m);
    expect(sql).toMatch(/set local lock_timeout = '5s';/);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql.indexOf("set local lock_timeout")).toBeGreaterThan(sql.indexOf("begin;"));
  });

  it("OFF by default: no seed row enables a studio and the settings column defaults to false", () => {
    expect(TOP_LEVEL).toMatch(/enabled boolean not null default false/);
    expect(TOP_LEVEL).not.toMatch(/insert into public\.studio_client_id_photo_settings/i);
    expect(EXECUTABLE).toMatch(/coalesce\(\(select s\.enabled from public\.studio_client_id_photo_settings s/);
  });

  it("seeds the wording UNAPPROVED, so no consent can be recorded until an operator approves it", () => {
    const seed = TOP_LEVEL.match(/insert into public\.client_id_photo_wording_versions[^;]*;/i)?.[0] ?? "";
    expect(seed).toContain("'v1.1'");
    expect(seed).not.toMatch(/approved_at/);
  });

  it("every table has RLS enabled and every API role revoked by name; only the photo table is readable", () => {
    for (const t of TABLES) {
      expect(TOP_LEVEL, t).toMatch(new RegExp(`alter table public\\.${t} enable row level security;`));
      expect(TOP_LEVEL, t).toMatch(
        new RegExp(`revoke all on table public\\.${t} from public, anon, authenticated, service_role;`),
      );
    }
    const grants = [...TOP_LEVEL.matchAll(/grant\s+[a-z ,]+\s+on\s+table\s+([\w.]+)\s+to\s+([^;]+);/gi)].map((m) => `${m[1]}->${m[2].trim()}`);
    expect(grants).toEqual(["public.client_id_photos->authenticated"]);
    expect(TOP_LEVEL).toMatch(/grant select on table public\.client_id_photos to authenticated;/);
    const policies = [...TOP_LEVEL.matchAll(/create policy "[^"]*"\s+on\s+([\w.]+)\s+for\s+(\w+)/gi)].map((m) => `${m[1]}:${m[2]}`);
    expect(policies).toEqual(["public.client_id_photos:select"]);
    expect(TOP_LEVEL).toMatch(/using \(public\.client_id_photo_can_read\(studio_id, client_id\)\)/);
  });

  it("the bucket is private, created in an exception wrapper, with NO storage.objects policy", () => {
    expect(sql).toMatch(/values \('client-identification-photos', 'client-identification-photos', false, 524288/);
    expect(sql).toMatch(/exception when insufficient_privilege or undefined_table then/);
    expect(EXECUTABLE).not.toMatch(/storage\.objects/);
  });

  it("evidence, log, audit and wording are append-only for every role, including truncate", () => {
    for (const t of ["client_id_photo_consents", "studio_client_id_photo_switch_log", "client_id_photo_audit"]) {
      expect(TOP_LEVEL).toMatch(new RegExp(`before update or delete on public\\.${t}`));
      expect(TOP_LEVEL).toMatch(new RegExp(`before truncate on public\\.${t}`));
    }
    expect(TOP_LEVEL).toMatch(/before delete on public\.client_id_photo_wording_versions/);
    expect(TOP_LEVEL).toMatch(/before update on public\.client_id_photo_wording_versions/);
  });

  it("the photo's path is anchored to its own studio and client, and the audit has no path column", () => {
    expect(TOP_LEVEL).toMatch(/storage_path ~ \('\^' \|\| studio_id::text \|\| '\/' \|\| client_id::text/);
    const audit = TOP_LEVEL.match(/create table public\.client_id_photo_audit \(([\s\S]*?)\n\);/)?.[1] ?? "";
    expect(audit.length).toBeGreaterThan(0);
    expect(audit).not.toMatch(/storage_path|\burl\b|filename|wording/);
  });
});

describe("0275's function privileges", () => {
  it("revokes EVERY created function from public, anon, authenticated and service_role by name", () => {
    const created = createdFunctions().map((f) => f.name).sort();
    const covered = [...AUTHENTICATED, ...SERVICE_ROLE_ONLY, ...NOBODY].map(([n]) => n).filter((n) => n !== "set_client_portrait").sort();
    expect(created).toEqual(covered);
  });

  it("authenticated commands: revoked from all four, granted to authenticated only", () => {
    for (const [fn, args] of AUTHENTICATED) {
      expect(revokedRoles(EXECUTABLE, fn, args), fn).toEqual(REQUIRED_REVOKES);
      expect(grantedRoles(EXECUTABLE, fn, args), fn).toEqual(["authenticated"]);
    }
  });

  it("C2: drain and ack are granted to service_role ONLY (no actor can acknowledge a deletion)", () => {
    for (const [fn, args] of SERVICE_ROLE_ONLY) {
      expect(revokedRoles(EXECUTABLE, fn, args), fn).toEqual(REQUIRED_REVOKES);
      expect(grantedRoles(EXECUTABLE, fn, args), fn).toEqual(["service_role"]);
    }
  });

  it("helpers, operator commands, trigger functions and the retired 0231 setter are granted to nobody", () => {
    for (const [fn, args] of NOBODY) {
      expect(revokedRoles(EXECUTABLE, fn, args), fn).toEqual(REQUIRED_REVOKES);
      expect(grantedRoles(EXECUTABLE, fn, args), fn).toEqual([]);
    }
  });

  it("has no blanket function grant", () => {
    expect(EXECUTABLE).not.toMatch(BLANKET_FUNCTION_GRANT);
  });

  it("every function is SECURITY DEFINER or a plain trigger guard with an empty search_path", () => {
    for (const m of EXECUTABLE.matchAll(/create or replace function public\.(\w+)\([\s\S]*?\$\$/g)) {
      expect(m[0], m[1]).toMatch(/set search_path = ''/);
    }
  });
});

describe("0275 revision conditions (Privacy C1-C4)", () => {
  it("C1: set accepts only a database-reserved path for this client, inside its window, and consumes it", () => {
    const set = createdFunctions().find((f) => f.name === "set_client_id_photo")!.body;
    expect(set).toMatch(/q\.reservation[\s\S]*q\.reserved_client_id = p_client_id[\s\S]*q\.delete_after > now\(\)/);
    expect(set).toMatch(/That upload was not reserved for this client/);
    const reserve = createdFunctions().find((f) => f.name === "reserve_client_id_photo_path")!.body;
    expect(reserve).toMatch(/gen_random_uuid\(\)::text \|\| '\.webp'/);
    expect(reserve).toMatch(/for update/);
    expect(reserve).toMatch(/insert into public\.client_id_photo_pending_object_deletions/);
  });

  it("C2: the drain never offers a live photo's path and never an undue reservation", () => {
    const drain = createdFunctions().find((f) => f.name === "pending_client_id_photo_object_deletions")!.body;
    expect(drain).toMatch(/q\.delete_after <= now\(\)/);
    expect(drain).toMatch(/not exists \(select 1 from public\.client_id_photos p where p\.storage_path = q\.storage_path\)/);
    expect(drain).not.toMatch(/auth\.uid|client_id_photo_actor/);
  });

  it("C3: consent is accepted only against the latest approved wording", () => {
    const rec = createdFunctions().find((f) => f.name === "record_client_id_photo_consent")!.body;
    expect(rec).toMatch(/order by w\.approved_at desc, w\.created_at desc\s+limit 1\) latest/);
  });

  it("C4: the bucket is hardened on insert and a PUBLIC bucket fails the migration", () => {
    expect(sql).toMatch(/file_size_limit, allowed_mime_types\)\s+values \('client-identification-photos', 'client-identification-photos', false, 524288, array\['image\/webp'\]\)/);
    expect(sql).toMatch(/where id = 'client-identification-photos' and public\) then\s+raise exception/);
    expect(sql).not.toMatch(/set public\s*=\s*true/i);
  });
});

describe("0275 keeps ID photos apart from treatment photos and closes the 0231 bypass", () => {
  it("no new function reads or writes treatment_images, the pointer or the 0231 setter, except the pointer freeze", () => {
    for (const f of createdFunctions()) {
      expect(f.body, f.name).not.toMatch(/treatment_images/);
      if (f.name !== "clients_portrait_pointer_frozen") {
        expect(f.body, f.name).not.toMatch(/portrait_image_id|set_client_portrait/);
      }
    }
    expect(TOP_LEVEL).not.toMatch(/references public\.treatment_images/);
  });

  it("freezes the pointer for every role, on insert and update, and never calls it a clear", () => {
    expect(TOP_LEVEL).toMatch(/before insert or update of portrait_image_id on public\.clients/);
    const body = createdFunctions().find((f) => f.name === "clients_portrait_pointer_frozen")!.body;
    expect(body).toMatch(/new\.portrait_image_id is not null/);
    expect(body).toMatch(/tg_op = 'INSERT' or new\.portrait_image_id is distinct from old\.portrait_image_id/);
  });

  it("does not rewrite or clear any existing pointer (a data write needing its own authorization)", () => {
    expect(TOP_LEVEL).not.toMatch(/update public\.clients/i);
    expect(TOP_LEVEL).not.toMatch(/portrait_image_id\s*=\s*null/i);
  });

  it("removes the photo on client archive without touching any other lane's function", () => {
    expect(TOP_LEVEL).toMatch(/after update of archived_at on public\.clients/);
    expect(EXECUTABLE).not.toMatch(/create or replace function public\.(archive_client|archive_treatment_image)\b/);
  });
});
