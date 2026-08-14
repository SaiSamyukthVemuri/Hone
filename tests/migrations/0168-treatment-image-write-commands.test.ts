import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// ===========================================================================
// L18 Phase 4, migration 0168 source contract.
// ===========================================================================

const SQL = readFileSync(
  "supabase/migrations/0168_treatment_image_write_commands.sql",
  "utf8",
);
const FLAT = SQL.replace(/\s+/g, " ");
const CODE = SQL.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");
const PROSE = SQL.split("\n")
  .filter((l) => l.trimStart().startsWith("--"))
  .join("\n");

const COMMANDS: ReadonlyArray<{ name: string; args: string }> = [
  {
    name: "create_treatment_image_metadata",
    args: "uuid, uuid, uuid, uuid, text, text, text, text, bigint",
  },
  { name: "set_treatment_image_note", args: "uuid, uuid, text" },
  { name: "archive_treatment_image", args: "uuid, uuid" },
];
const HELPERS: ReadonlyArray<{ name: string; args: string }> = [
  { name: "treatment_image_actor", args: "" },
];
const ALL = [...COMMANDS, ...HELPERS];

// The "nothing above me" tripwire moved to 0169's own test when that migration
// landed: only the CURRENT repository maximum may assert it.

describe("0168: three fixed-purpose commands", () => {
  it("declares exactly the three commands and one helper", () => {
    const declared = [...SQL.matchAll(/create or replace function public\.(\w+)\(/g)].map(
      (m) => m[1],
    );
    expect(declared.sort()).toEqual(ALL.map((f) => f.name).sort());
  });

  it("every function is SECURITY DEFINER with an empty search_path", () => {
    const bodies = SQL.split("create or replace function public.").slice(1);
    expect(bodies).toHaveLength(ALL.length);
    for (const b of bodies) {
      const head = b.slice(0, b.indexOf("as $$"));
      expect(head).toMatch(/security definer/);
      expect(head).toMatch(/set search_path = ''/);
    }
  });

  it("derives the actor from auth.uid() and never consults current_user", () => {
    expect(SQL).toMatch(/auth\.uid\(\)/);
    expect(CODE).not.toMatch(/current_user/);
  });

  it("accepts no studio id, actor id or uploader from the caller", () => {
    for (const c of COMMANDS) {
      const seg = SQL.slice(SQL.indexOf(`create or replace function public.${c.name}(`));
      const params = seg.slice(0, seg.indexOf(")"));
      expect(params, `${c.name} studio`).not.toMatch(/p_studio_id/);
      expect(params, `${c.name} actor`).not.toMatch(/p_practitioner|p_uploaded_by|p_actor/);
      expect(params, `${c.name} deleted_by`).not.toMatch(/p_deleted_by/);
    }
  });

  it("uses no dynamic SQL and no generic patch mechanism", () => {
    expect(FLAT).not.toMatch(/execute format/i);
    expect(FLAT).not.toMatch(/quote_ident/i);
    expect(FLAT).not.toMatch(/jsonb_populate_record/i);
    expect(FLAT).not.toMatch(/p_fields|p_patch|p_column/);
    // No jsonb bag at all on this surface, every parameter is typed.
    for (const c of COMMANDS) {
      const seg = SQL.slice(SQL.indexOf(`create or replace function public.${c.name}(`));
      expect(seg.slice(0, seg.indexOf(")"))).not.toMatch(/jsonb/);
    }
  });

  it("cannot upload, sign or delete a storage object", () => {
    expect(FLAT).not.toMatch(/storage\./i);
    expect(FLAT).not.toMatch(/delete from/i);
  });

  it("pins the bucket and re-derives the storage path from studio/client/id", () => {
    expect(SQL).toMatch(/'treatment-images'/);
    expect(SQL).toMatch(/v_expected := v_studio::text/);
    expect(SQL).toMatch(/position\(v_expected in p_storage_path\) <> 1/);
  });

  it("derives the session from the block, and refuses a disagreeing session id", () => {
    const seg = SQL.slice(
      SQL.indexOf("function public.create_treatment_image_metadata("),
    );
    const body = seg.slice(0, seg.indexOf("$$;"));
    expect(body).toMatch(/v_block_sess/);
    expect(body).toMatch(/p_session_id <> v_block_sess/);
  });

  it("archive is SOFT, database-stamped and actor-derived", () => {
    const seg = SQL.slice(SQL.indexOf("function public.archive_treatment_image("));
    const body = seg.slice(0, seg.indexOf("$$;"));
    expect(body).toMatch(/set deleted_at = now\(\)/);
    expect(body).toMatch(/deleted_by = v_pract/);
    expect(body).toMatch(/t\.deleted_at is null/);
  });

  it("the note command enforces the limit as a backstop and clears on whitespace", () => {
    const seg = SQL.slice(SQL.indexOf("function public.set_treatment_image_note("));
    const body = seg.slice(0, seg.indexOf("$$;"));
    expect(body).toMatch(/nullif\(btrim\(coalesce\(p_note, ''\)\), ''\)/);
    expect(body).toMatch(/length\(v_note\) > 1000/);
  });
});

describe("0168: privileges", () => {
  const sig = (f: { name: string; args: string }) =>
    `public.${f.name}(${f.args})`;

  it("revokes every signature from all four grantees, literally", () => {
    for (const f of ALL) {
      for (const role of ["public", "anon", "service_role", "authenticated"]) {
        expect(SQL, `${f.name} / ${role}`).toContain(
          `revoke execute on function ${sig(f)} from ${role};`,
        );
      }
    }
    expect((SQL.match(/^revoke execute on function/gm) ?? []).length).toBe(ALL.length * 4);
  });

  it("grants ONLY the three commands, and only to authenticated", () => {
    for (const c of COMMANDS) {
      expect(SQL).toContain(`grant execute on function ${sig(c)} to authenticated;`);
    }
    expect((SQL.match(/^grant execute on function/gm) ?? []).length).toBe(COMMANDS.length);
    expect(FLAT).not.toMatch(/grant execute[^;]*to[^;]*service_role/i);
    expect(FLAT).not.toMatch(/grant execute[^;]*to[^;]*anon/i);
  });

  it("never grants the helper back", () => {
    expect(FLAT).not.toContain("grant execute on function public.treatment_image_actor");
  });
});

describe("0168: additive and honest about scope", () => {
  it("revokes no TABLE privilege and drops no policy", () => {
    expect(FLAT).not.toMatch(/revoke[^;]*on public\.treatment_images/i);
    expect(FLAT).not.toMatch(/revoke[^;]*on table/i);
    expect(FLAT).not.toMatch(/drop policy/i);
  });

  it("makes no schema, trigger or data change", () => {
    expect(FLAT).not.toMatch(
      /\bcreate table\b|\balter table\b|\bcreate trigger\b|\bdrop trigger\b/i,
    );
    expect(FLAT).not.toMatch(/\btruncate\b/i);
  });

  it("opens its own transaction with an armed lock_timeout", () => {
    expect(SQL).toMatch(/^begin;/m);
    expect(SQL).toMatch(/^set local lock_timeout/m);
    expect(SQL).toMatch(/^commit;/m);
  });

  it("states that storage and Postgres are NOT one transaction", () => {
    expect(PROSE).toMatch(/cannot share a transaction/i);
    expect(PROSE).toMatch(/compensating cleanup/i);
    // Newline-tolerant: the sentence wraps across comment lines.
    const flatProse = PROSE.replace(/\s*\n\s*--\s*/g, " ");
    expect(flatProse).toMatch(/nothing here should be read as making the upload atomic/i);
  });

  it("records the census and does NOT claim L18 is closed", () => {
    expect(PROSE).toMatch(/treatment_images \(3\)/);
    expect(PROSE).toMatch(/treatment_images 0/);
    expect(PROSE).toMatch(/L18 REMAINS OPEN/i);
    expect(PROSE).toMatch(/is NOT\s*--?\s*revoked here|NOT\s+revoked here/i);
  });
});
