import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// CENSUS: every file that reads the waitlist entry table directly. A column added to that table later (for example a practitioner preference) has to be
// added in ALL of its readers or none, and a reader that is not on this list is one nobody planned for. Adding a reader means adding it here in the same
// commit, which makes the new one visible in review. It counts the table's own reads (from("new_client_waitlist_entries")), not the database commands.
const TABLE_READ = /\.from\(\s*["'`]new_client_waitlist_entries["'`]\s*\)/g;
const ROOTS = ["app", "lib", "components"];
const KNOWN: Record<string, number> = {
  "app/(app)/settings/waitlist/consent-actions.ts": 1,
  "app/(app)/settings/waitlist/over-invite/page.tsx": 1,
  "app/(app)/settings/waitlist/page.tsx": 1,
  "app/invitation/[token]/actions.ts": 1,
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
    const n = (readFileSync(f, "utf8").match(TABLE_READ) ?? []).length;
    if (n > 0) r[f.split("\\").join("/")] = n;
  }
  return r;
};

describe("readers of the waitlist entry table", () => {
  it("are exactly the known ones, with their counts (17 reads in 14 files today)", () => {
    expect(found()).toEqual(KNOWN);
    expect(Object.values(KNOWN).reduce((a, b) => a + b, 0)).toBe(17);
  });
  it("the scan is not vacuous: its pattern matches the spellings in use and refuses other tables", () => {
    const m = (s: string) => (s.match(TABLE_READ) ?? []).length;
    expect(m('supabase.from("new_client_waitlist_entries").select("id")')).toBe(1);
    expect(m("admin\n  .from(\n 'new_client_waitlist_entries'\n)")).toBe(1);
    expect(m('.from("new_client_waitlist_invitations")')).toBe(0);
    expect(m('.from("new_client_waitlist_entry_preferences")')).toBe(0);
  });
});
