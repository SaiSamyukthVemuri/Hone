import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// HON-7: what a withdrawal and "Keep on the waitlist" do, pinned from both sides without a database.
//   1. A withdrawal sends NO owner email: no outbox row is written and nothing dispatches one.
//   2. Keep changes nothing about the entry. The person is already back in Waiting, in their original place, from the moment they withdrew;
//      Keep only closes the owner's follow-up row.
// The DB suite (tests/db/waitlist-decline-followups.db.test.ts) proves the same rows against a real database; these tests pin the SQL text
// and the app wiring so a change on either side fails here too.

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({ rpc: h.rpc, from: h.from }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

import { requestWithdrawal } from "@/lib/booking/waitlist-invitation";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIGRATIONS = readdirSync(join(ROOT, "supabase", "migrations")).filter((f) => f.endsWith(".sql")).sort();

/** The body of the LAST `create [or replace] function public.<name>(` in the migration chain (a plain `create function` after a drop counts), up to its closing `$$;`. */
function lastBody(name: string): string {
  let found = "";
  const head = new RegExp(`create (?:or replace )?function public\\.${name}\\(`, "g");
  for (const f of MIGRATIONS) {
    const sql = read(`supabase/migrations/${f}`);
    for (const m of sql.matchAll(head)) {
      const end = sql.indexOf("\n$$;", m.index);
      found = sql.slice(m.index, end === -1 ? undefined : end);
    }
  }
  return found;
}
const strip = (sql: string) => sql.replace(/--[^\n]*/g, "");
const RAW = "a".repeat(64);

describe("a withdrawal sends no owner email", () => {
  it("the withdrawal command writes the follow-up and the bell, and never the owner-email outbox", () => {
    const body = strip(lastBody("request_waitlist_withdrawal"));
    expect(body.length).toBeGreaterThan(500);
    expect(body).toMatch(/insert into public\.waitlist_followups/);
    expect(body).toMatch(/insert into public\.practitioner_notifications/);
    expect(body).not.toMatch(/waitlist_decline_owner_emails/);
  });

  // Stated bound: this reads literal `insert into public.waitlist_decline_owner_emails` text. A write built as dynamic SQL (execute format(...)) or
  // through a view would not be seen here; the DB suite's 0-row assertion after a withdrawal is what covers that case.
  it("the outbox is written in exactly one place in the whole chain: the decline-with-answers command", () => {
    const hits: string[] = [];
    for (const f of MIGRATIONS) {
      const sql = strip(read(`supabase/migrations/${f}`));
      let at = sql.indexOf("insert into public.waitlist_decline_owner_emails");
      while (at !== -1) {
        const fn = [...sql.slice(0, at).matchAll(/create (?:or replace )?function public\.(\w+)\(/g)].pop()?.[1] ?? "(none)";
        hits.push(`${f}:${fn}`);
        at = sql.indexOf("insert into public.waitlist_decline_owner_emails", at + 10);
      }
    }
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(hit.split(":")[1]).toBe("decline_waitlist_invitation_with_answers");
  });

  it("the withdrawal wrapper makes one command call and touches no table, so it cannot enqueue or send anything", async () => {
    h.rpc.mockReset();
    h.from.mockReset();
    h.rpc.mockResolvedValue({ data: [{ result: "recorded" }], error: null });
    expect(await requestWithdrawal({ rawToken: RAW, rawCapability: RAW })).toEqual({ kind: "recorded" });
    expect(h.rpc).toHaveBeenCalledTimes(1);
    expect(h.rpc.mock.calls[0]![0]).toBe("request_waitlist_withdrawal");
    expect(h.from).not.toHaveBeenCalled();
  });

  it("the withdrawal action never hands anything to the owner-email dispatcher", () => {
    const actions = read("app/invitation/[token]/actions.ts");
    const start = actions.indexOf("export async function noLongerNeedAction");
    const body = actions.slice(start, actions.indexOf("export async function timesDontWorkAction", start));
    expect(body.length).toBeGreaterThan(300);
    expect(body).not.toMatch(/dispatchDeclineOwnerEmail|decline-owner-email|after\(/);
    // The wrapper's module has no reference to the outbox either.
    expect(read("lib/booking/waitlist-invitation.ts")).not.toMatch(/waitlist_decline_owner_emails/);
  });
});

describe("Keep on the waitlist changes the follow-up row and nothing about the entry", () => {
  it("the withdrawal command already returns the entry to Waiting, and never touches the column the queue is ordered by", () => {
    const body = strip(lastBody("request_waitlist_withdrawal"));
    const updates = [...body.matchAll(/update public\.new_client_waitlist_entries[\s\S]*?;/g)].map((m) => m[0]);
    expect(updates.length).toBe(2);
    expect(updates.join("\n")).toMatch(/set status = 'waiting'/);
    for (const u of updates) expect(u).not.toMatch(/joined_at|position|rank|created_at/);
    // Both ways in (an outstanding offer, or an expired one) end in Waiting.
    expect(updates[1]).toMatch(/status in \('released','expired'\)/);
    // The owner's queue is ordered by joined_at, then id: the original place.
    expect(read("app/(app)/settings/waitlist/page.tsx")).toMatch(/\.order\("joined_at", \{ ascending: true \}\)/);
  });

  it("the Keep command only closes the follow-up row: it takes a lock on the entry but writes nothing to it", () => {
    const body = strip(lastBody("keep_waitlist_withdrawal"));
    expect(body.length).toBeGreaterThan(300);
    expect(body).toMatch(/update public\.waitlist_followups\s+set status = 'kept'/);
    expect(body).not.toMatch(/update public\.new_client_waitlist_entries/);
    expect(body).not.toMatch(/insert into|delete from/);
    // It only acts on an open withdrawal row, so a second press changes nothing.
    expect(body).toMatch(/already_resolved/);
  });
});
