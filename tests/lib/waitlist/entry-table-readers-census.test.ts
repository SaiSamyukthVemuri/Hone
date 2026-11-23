import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// A TEXTUAL CENSUS, not a reader list: it counts the spellings from("new_client_waitlist_entries") in code, with comments removed first, so a comment that
// quotes one is not a read. A column added to that table later (for example a practitioner preference) has to be handled in every real reader, and a new
// file that matches is one nobody planned for; adding one means adding it here in the same commit, which puts it in front of the reviewer.
//
// WHAT IT DOES NOT SEE (residual limits): a table name held in a variable or built from pieces (const T = "..."; db.from(T)), a read through an embedded
// select of another table, a read through a database command, and any code outside app, lib and components. Treat a green run as "no new literal
// spelling", not as proof that these are all the readers.
const TABLE_READ = /\.from\(\s*["'`]new_client_waitlist_entries["'`]\s*\)/g;
// Comments are removed before matching: block comments, and // comments that do not follow a colon (so a URL is kept). Strings holding "//" are a residual limit.
export const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const ROOTS = ["app", "lib", "components"];
const KNOWN: Record<string, number> = {
  "app/(app)/settings/waitlist/consent-actions.ts": 1,
  "app/(app)/settings/waitlist/over-invite/page.tsx": 1,
  "app/(app)/settings/waitlist/page.tsx": 1,
  "lib/business-analytics/server/waitlist-read.ts": 1,
  "lib/waitlist/decline-visibility-read.ts": 2,
  "lib/waitlist/declined-attention.ts": 1,
  "lib/waitlist/entry-search.ts": 3,
  "lib/waitlist/entry-status-readback.ts": 1,
  "lib/waitlist/followup-linkable.ts": 1,
  "lib/waitlist/needs-attention.ts": 1,
  "lib/waitlist/operator-queue-presence.ts": 1,
  "lib/waitlist/over-invite-deliver.ts": 1,
  "lib/waitlist/reply-contact.ts": 1,
};
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const found = (): Record<string, number> => {
  const r: Record<string, number> = {};
  for (const root of ROOTS) for (const f of walk(root)) {
    const n = (stripComments(readFileSync(f, "utf8")).match(TABLE_READ) ?? []).length;
    if (n > 0) r[f.split("\\").join("/")] = n;
  }
  return r;
};

describe("readers of the waitlist entry table", () => {
  it("are exactly the known ones, with their counts (16 reads in 13 files today)", () => {
    expect(found()).toEqual(KNOWN);
    expect(Object.values(KNOWN).reduce((a, b) => a + b, 0)).toBe(16);
  });
  it("the scan is not vacuous: its pattern matches the spellings in use and refuses other tables", () => {
    const m = (s: string) => (s.match(TABLE_READ) ?? []).length;
    expect(m('supabase.from("new_client_waitlist_entries").select("id")')).toBe(1);
    expect(m("admin\n  .from(\n 'new_client_waitlist_entries'\n)")).toBe(1);
    expect(m('.from("new_client_waitlist_invitations")')).toBe(0);
    expect(m('.from("new_client_waitlist_entry_preferences")')).toBe(0);
  });
  it("a mention in a comment is not a read, and real code next to a comment still is", () => {
    const c = (s: string) => (stripComments(s).match(TABLE_READ) ?? []).length;
    expect(c('// admin.from("new_client_waitlist_entries").select("x")\nconst a = 1;')).toBe(0);
    expect(c('/**\n * `admin.from("new_client_waitlist_entries")` was a read\n */\nconst a = 1;')).toBe(0);
    expect(c('const r = admin.from("new_client_waitlist_entries"); // read\n')).toBe(1);
    expect(c('const u = "https://x.test/a"; const r = admin.from("new_client_waitlist_entries");')).toBe(1);
  });
});
