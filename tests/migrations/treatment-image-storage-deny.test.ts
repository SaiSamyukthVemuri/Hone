import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The treatment-images bucket is SERVICE-ROLE ONLY (0093). A practitioner's JWT cannot read an object directly, whatever
// has_studio_permission says, so the only way to a photo is the server signer, which asks clin.view_photos. Adding an
// authenticated storage.objects policy would REOPEN the direct-read path 0093 closed, so this guard fails if one is ever
// left standing after the whole migration chain.
const DIR = "supabase/migrations";
const files = readdirSync(DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

describe("no authenticated storage.objects policy for treatment-images survives the migration chain", () => {
  it("replays create/drop policy statements in order and ends with none", () => {
    const live = new Map<string, string>(); // policy name -> file
    for (const f of files) {
      const sql = readFileSync(join(DIR, f), "utf8");
      const stmts = sql.split(/;\s*\n/);
      for (const st of stmts) {
        const d = st.match(/drop policy if exists\s+"([^"]+)"\s+on storage\.objects/i);
        if (d) live.delete(d[1]);
        const c = st.match(/create policy\s+"([^"]+)"\s+on storage\.objects/i);
        if (c && /treatment[-_]images/i.test(st)) live.set(c[1], f);
      }
    }
    expect([...live.entries()], "a treatment-images storage.objects policy is still live").toEqual([]);
  });

  it("0093 is the migration that removed them, and 0092 is the only one that created them", () => {
    const created = files.filter((f) => /create policy\s+"treatment_images_objects/i.test(readFileSync(join(DIR, f), "utf8")));
    expect(created).toEqual(["0092_treatment_images.sql"]);
    expect(readFileSync(join(DIR, "0093_harden_treatment_image_storage.sql"), "utf8")).toMatch(/drop policy if exists "treatment_images_objects: members select" on storage\.objects/);
  });
});
