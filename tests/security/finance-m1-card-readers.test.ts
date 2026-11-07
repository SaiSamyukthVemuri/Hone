import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Finance DB closure M1 (0302). client_payment_methods is readable only by the studio OWNER
// through the Data API. That is safe ONLY because every application reader runs on the
// service role. This guard pins that: any `.from("client_payment_methods")` in application
// code must be called on a client bound to createAdminClient() (the receiver is named
// admin*). A user-token reader added later would silently return zero rows for a
// practitioner (or, worse, be "fixed" by loosening the policy); it fails here instead.

const ROOT = join(__dirname, "..", "..");
const DIRS = ["app", "lib", "components"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const READER = /(\w+)\s*\.from\(\s*["']client_payment_methods["']\s*\)/g;

describe("client_payment_methods readers (finance M1)", () => {
  const hits: { file: string; receiver: string }[] = [];
  for (const d of DIRS) {
    for (const f of walk(join(ROOT, d))) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(READER)) hits.push({ file: f.slice(ROOT.length + 1), receiver: m[1] });
    }
  }

  it("finds the known readers (the guard is not vacuous)", () => {
    expect(hits.length).toBeGreaterThanOrEqual(10);
  });

  it("every reader is on the service role (receiver admin*)", () => {
    const bad = hits.filter((h) => !/^admin\w*$/.test(h.receiver));
    expect(bad).toEqual([]);
  });

  it("every admin* receiver is BOUND to createAdminClient() in its file (Privacy M-4), or is a parameter of a known helper", () => {
    // The receiver NAME alone proves nothing. Bound = `const admin = createAdminClient()` in the same file.
    // Parameter form (`admin: SupabaseClient`) cannot be proven from this file; the files that use it are pinned, so a NEW
    // parameter-form reader fails here and must be reviewed (its callers must pass the service-role client).
    const PARAM_ALLOWED = new Set(["lib/billing/card-change-notification.ts", "lib/payments/admin-payment-status.ts"]);
    const unproven: string[] = [];
    for (const h of hits) {
      const text = readFileSync(join(ROOT, h.file), "utf8");
      const bound = new RegExp(`\\b(const|let)\\s+${h.receiver}\\s*(:[^=]+)?=\\s*(await\\s+)?createAdminClient\\(`).test(text);
      if (!bound && !PARAM_ALLOWED.has(h.file)) unproven.push(`${h.file} (${h.receiver})`);
    }
    expect(unproven).toEqual([]);
  });

  it("no reader sits in a client component", () => {
    for (const h of hits) {
      const text = readFileSync(join(ROOT, h.file), "utf8");
      expect(/^\s*["']use client["']/m.test(text.split("\n").slice(0, 5).join("\n"))).toBe(false);
    }
  });

  it("no select embeds the table (an embed would read it on the caller's token)", () => {
    const EMBED = /["'`][^"'`\n]*\bclient_payment_methods\s*(!\w+)?\s*\([^"'`\n]*["'`]/g;
    const offenders: string[] = [];
    for (const d of DIRS) {
      for (const f of walk(join(ROOT, d))) {
        const text = readFileSync(f, "utf8");
        for (const line of text.split("\n")) {
          if (/^\s*(\/\/|\*)/.test(line)) continue;
          if (/\.select\(/.test(line) && EMBED.test(line)) offenders.push(f.slice(ROOT.length + 1));
          EMBED.lastIndex = 0;
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("negative control: the matcher rejects a user-token receiver", () => {
    const sample = `const supabase = await createClient(); await supabase.from("client_payment_methods").select("*");`;
    const found = [...sample.matchAll(READER)].map((m) => m[1]);
    expect(found).toEqual(["supabase"]);
    expect(/^admin\w*$/.test(found[0])).toBe(false);
  });
});
