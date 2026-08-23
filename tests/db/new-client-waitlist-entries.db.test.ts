import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  adminTx,
  asRole,
  asUser,
  closePool,
  seedMember,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// ===========================================================================
// WAIT-02 — the durable new-client waitlist, on the REAL migrated database
// ===========================================================================
//
// Migration 0185 proven by behaviour rather than by reading its SQL. The
// properties that would actually hurt if they were wrong:
//
//   1. TENANCY. One studio can never read, remove or deduplicate against
//      another's list, and an anonymous visitor can read nothing at all.
//   2. THE JOIN IS ATOMIC. Two simultaneous identical submissions produce ONE
//      waiting entry and one calm "already waiting" — not two rows, and not a
//      raised unique violation that the caller has to interpret.
//   3. NO BUSINESS SIDE EFFECTS. Joining a waitlist creates no client, no
//      appointment, no session and no intake. WAITING != CLIENT.
//   4. THE QUEUE HAS A TOTAL ORDER, so it does not shuffle between renders.
//   5. REMOVAL IS A TRANSITION, authorized in the database, never a delete.
//
// NEGATIVE CONTROLS. Two of these tests are written so that a specific,
// plausible mutation makes them fail, and one performs the mutation for real
// inside a rolled-back transaction (see "negative control" below).
//
// Every assertion is scoped by ids seeded here, never by global counts, so the
// suite is safe to re-run against a database other worktrees are sharing.

let a: SeededStudio; // studio A
let b: SeededStudio; // studio B
let aMember: { userId: string; practitionerId: string }; // non-owner in A

const email = (label: string) => `wait02-${label}-${randomUUID().slice(0, 8)}@harness.local`;

async function join(
  studioId: string,
  name: string,
  addr: string,
  phone: string | null = null,
): Promise<{ result: string; entry_id: string | null }> {
  const res = await adminQuery(
    "select result, entry_id from public.join_new_client_waitlist($1, $2, $3, $4)",
    [studioId, name, addr, phone],
  );
  return res.rows[0] as { result: string; entry_id: string | null };
}

async function remove(
  studioId: string,
  entryId: string,
  actorUserId: string,
): Promise<string> {
  const res = await adminQuery(
    "select public.remove_new_client_waitlist_entry($1, $2, $3) as outcome",
    [studioId, entryId, actorUserId],
  );
  return res.rows[0].outcome as string;
}

async function waitingCount(studioId: string, addr: string): Promise<number> {
  const res = await adminQuery(
    `select count(*)::int as n from public.new_client_waitlist_entries
      where studio_id = $1 and email_normalized = lower(btrim($2)) and status = 'waiting'`,
    [studioId, addr],
  );
  return res.rows[0].n as number;
}

beforeAll(async () => {
  a = await seedStudio("wait02-a");
  b = await seedStudio("wait02-b");
  aMember = await seedMember(a, "wait02-a-member");
});

afterAll(async () => {
  await closePool();
});

// ---------------------------------------------------------------------------
// 1. TENANCY
// ---------------------------------------------------------------------------
describe("0185: tenancy", () => {
  it("studio A's OWNER reads A's entries and NOT B's", async () => {
    const shared = email("cross");
    const inA = await join(a.studioId, "Person A", shared);
    const inB = await join(b.studioId, "Person B", shared);
    expect(inA.result).toBe("created");
    expect(inB.result).toBe("created");

    const seen = await asUser(a.userId, (q) =>
      q("select id, studio_id from public.new_client_waitlist_entries where id = any($1)", [
        [inA.entry_id, inB.entry_id],
      ]),
    );
    expect(seen.rows.map((r) => r.id)).toEqual([inA.entry_id]);
  });

  it("studio B's owner cannot see A's entry even when asked for it by id", async () => {
    const created = await join(a.studioId, "Only A", email("only-a"));
    const seen = await asUser(b.userId, (q) =>
      q("select id from public.new_client_waitlist_entries where id = $1", [created.entry_id]),
    );
    expect(seen.rows).toHaveLength(0);
  });

  it("a NON-OWNER member of the SAME studio sees nothing", async () => {
    // Owner is the narrowest existing authority for this surface, and the
    // policy — not just the page — is what enforces it.
    const created = await join(a.studioId, "Owner Only", email("owner-only"));
    const seen = await asUser(aMember.userId, (q) =>
      q("select id from public.new_client_waitlist_entries where id = $1", [created.entry_id]),
    );
    expect(seen.rows).toHaveLength(0);
  });

  it("anon holds NO privilege on the table and cannot enumerate it", async () => {
    await asRole("anon", async (q) => {
      const priv = await q(
        "select has_table_privilege('anon', 'public.new_client_waitlist_entries', $1) as ok",
        ["select"],
      );
      expect(priv.rows[0].ok).toBe(false);
      await expect(
        q("select count(*) from public.new_client_waitlist_entries"),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  it("service_role holds NO privilege on the table either — only on the commands", async () => {
    // The commands are SECURITY DEFINER, so the server's most privileged
    // client can join and remove but cannot read or dump contact details.
    for (const priv of ["select", "insert", "update", "delete"]) {
      const res = await adminQuery(
        "select has_table_privilege('service_role', 'public.new_client_waitlist_entries', $1) as ok",
        [priv],
      );
      expect(res.rows[0].ok, `service_role must not hold ${priv}`).toBe(false);
    }
  });

  it("`authenticated` holds SELECT and nothing else", async () => {
    const res = await adminQuery(
      `select
         has_table_privilege('authenticated','public.new_client_waitlist_entries','select') as sel,
         has_table_privilege('authenticated','public.new_client_waitlist_entries','insert') as ins,
         has_table_privilege('authenticated','public.new_client_waitlist_entries','update') as upd,
         has_table_privilege('authenticated','public.new_client_waitlist_entries','delete') as del`,
    );
    expect(res.rows[0]).toEqual({ sel: true, ins: false, upd: false, del: false });
  });

  it("neither anon nor authenticated may EXECUTE either command", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      const res = await adminQuery(
        `select
           has_function_privilege($1,'public.join_new_client_waitlist(uuid,text,text,text)','execute') as j,
           has_function_privilege($1,'public.remove_new_client_waitlist_entry(uuid,uuid,uuid)','execute') as r`,
        [role],
      );
      expect(res.rows[0], `${role} must not execute the commands`).toEqual({ j: false, r: false });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. JOIN
// ---------------------------------------------------------------------------
describe("0185: join", () => {
  it("a first eligible submission creates EXACTLY ONE row", async () => {
    const addr = email("first");
    const res = await join(a.studioId, "First Person", addr, " 555 0101 ");
    expect(res.result).toBe("created");
    expect(await waitingCount(a.studioId, addr)).toBe(1);

    const row = await adminQuery(
      "select * from public.new_client_waitlist_entries where id = $1",
      [res.entry_id],
    );
    expect(row.rows[0].status).toBe("waiting");
    expect(row.rows[0].source).toBe("public_booking");
    expect(row.rows[0].phone).toBe("555 0101"); // trimmed by the command
    expect(row.rows[0].removed_at).toBeNull();
    expect(row.rows[0].removed_by_practitioner_id).toBeNull();
  });

  it("NORMALIZATION IS THE DATABASE'S: case and whitespace collide", async () => {
    const addr = `Wait02.Mixed.${randomUUID().slice(0, 8)}@Harness.Local`;
    const first = await join(a.studioId, "Mixed Case", `  ${addr}  `);
    expect(first.result).toBe("created");

    const again = await join(a.studioId, "Mixed Case", addr.toLowerCase());
    expect(again.result).toBe("already_waiting");
    expect(again.entry_id).toBe(first.entry_id);

    const stored = await adminQuery(
      "select email, email_normalized from public.new_client_waitlist_entries where id = $1",
      [first.entry_id],
    );
    // The command lowercases what it stores AND the database derives the
    // comparison key independently, so the rule holds either way.
    expect(stored.rows[0].email_normalized).toBe(addr.toLowerCase());
  });

  it("a duplicate submission is ALREADY_WAITING and adds no row", async () => {
    const addr = email("dupe");
    await join(a.studioId, "Dupe", addr);
    const second = await join(a.studioId, "Dupe Again", addr);
    expect(second.result).toBe("already_waiting");
    expect(await waitingCount(a.studioId, addr)).toBe(1);
  });

  it("THE SAME PERSON MAY WAIT AT TWO DIFFERENT STUDIOS", async () => {
    // NEGATIVE CONTROL: if studio_id were dropped from the uniqueness rule,
    // the second join here would come back `already_waiting` and this fails.
    const addr = email("two-studios");
    expect((await join(a.studioId, "Dual", addr)).result).toBe("created");
    expect((await join(b.studioId, "Dual", addr)).result).toBe("created");
    expect(await waitingCount(a.studioId, addr)).toBe(1);
    expect(await waitingCount(b.studioId, addr)).toBe(1);
  });

  it("removal frees the slot: the same person can rejoin later", async () => {
    const addr = email("rejoin");
    const first = await join(a.studioId, "Rejoiner", addr);
    expect(await remove(a.studioId, first.entry_id!, a.userId)).toBe("removed");
    const second = await join(a.studioId, "Rejoiner", addr);
    expect(second.result).toBe("created");
    expect(second.entry_id).not.toBe(first.entry_id);
    // ...and the old row is still there, still removed.
    const rows = await adminQuery(
      `select status from public.new_client_waitlist_entries
        where studio_id = $1 and email_normalized = lower($2) order by joined_at`,
      [a.studioId, addr],
    );
    expect(rows.rows.map((r) => r.status)).toEqual(["removed", "waiting"]);
  });

  it("malformed input is refused, and nothing is written", async () => {
    for (const [name, addr] of [
      ["No At Sign", "not-an-email"],
      ["No Domain Dot", "person@localhost"],
      ["Spaces", "a b@example.com"],
      ["", "blank-name@example.com"],
      ["Too Long", `${"x".repeat(250)}@example.com`],
    ] as const) {
      const res = await join(a.studioId, name, addr);
      expect(res.result, `${name} / ${addr}`).toBe("invalid_input");
      expect(res.entry_id).toBeNull();
    }
    const overLongName = await join(a.studioId, "y".repeat(121), email("long-name"));
    expect(overLongName.result).toBe("invalid_input");
    const overLongPhone = await join(a.studioId, "Phoney", email("long-phone"), "9".repeat(41));
    expect(overLongPhone.result).toBe("invalid_input");
  });

  it("an unknown studio is refused as a closed code, not an exception", async () => {
    const res = await join(randomUUID(), "Ghost", email("ghost"));
    expect(res.result).toBe("studio_not_found");
    expect(res.entry_id).toBeNull();
  });

  it("a caller-supplied joined_at cannot jump the queue", async () => {
    const res = await adminQuery(
      `insert into public.new_client_waitlist_entries (studio_id, name, email, joined_at)
       values ($1, 'Queue Jumper', $2, '2001-01-01T00:00:00Z') returning joined_at`,
      [a.studioId, email("jumper")],
    );
    expect(new Date(res.rows[0].joined_at).getUTCFullYear()).toBeGreaterThan(2001);
  });
});

// ---------------------------------------------------------------------------
// 3. CONCURRENCY
// ---------------------------------------------------------------------------
describe("0185: concurrent joins", () => {
  it("a DETERMINISTIC interleaving yields one row and one already_waiting", async () => {
    // NEGATIVE CONTROL for check-then-insert. The second caller runs while the
    // first's INSERT is still UNCOMMITTED. A read-then-insert implementation
    // would see nothing, insert, and either duplicate the person or raise a
    // unique violation. ON CONFLICT DO NOTHING instead waits on the in-flight
    // speculative insertion, then reads the committed winner.
    const addr = email("race");
    let second!: Promise<{ result: string; entry_id: string | null }>;
    let stillPendingWhileUncommitted = false;

    await adminTx(async (q) => {
      const first = await q(
        "select result, entry_id from public.join_new_client_waitlist($1, $2, $3, null)",
        [a.studioId, "Racer One", addr],
      );
      expect(first.rows[0].result).toBe("created");

      // Fired on a DIFFERENT pooled connection while this transaction is open.
      second = join(a.studioId, "Racer Two", addr);
      // Swallow-and-rethrow-later so an early rejection is never unhandled.
      const settled = second.then(
        () => "settled" as const,
        () => "settled" as const,
      );
      const raced = await Promise.race([
        settled,
        new Promise<"pending">((r) => setTimeout(() => r("pending"), 400)),
      ]);
      stillPendingWhileUncommitted = raced === "pending";
    });

    expect(
      stillPendingWhileUncommitted,
      "the second caller must BLOCK on the uncommitted insert, not read past it",
    ).toBe(true);

    expect((await second).result).toBe("already_waiting");
    expect(await waitingCount(a.studioId, addr)).toBe(1);
  });

  it("four simultaneous identical submissions produce exactly one waiting entry", async () => {
    const addr = email("stampede");
    const results = await Promise.all(
      [1, 2, 3, 4].map((n) => join(a.studioId, `Stampede ${n}`, addr)),
    );
    const created = results.filter((r) => r.result === "created");
    expect(created).toHaveLength(1);
    expect(results.filter((r) => r.result === "already_waiting")).toHaveLength(3);
    // Every caller is told about the SAME entry.
    expect(new Set(results.map((r) => r.entry_id)).size).toBe(1);
    expect(await waitingCount(a.studioId, addr)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. NO BUSINESS SIDE EFFECTS
// ---------------------------------------------------------------------------
describe("0185: joining creates no business state", () => {
  it("0 clients, 0 appointments, 0 sessions, 0 intakes", async () => {
    const before = await businessCounts(a.studioId);
    const res = await join(a.studioId, "Side Effect Probe", email("side-effect"), "555 0199");
    expect(res.result).toBe("created");
    const after = await businessCounts(a.studioId);
    expect(after).toEqual(before);
  });

  it("nothing reaches the MARKETING waitlist table", async () => {
    const addr = email("marketing");
    await join(a.studioId, "Not Marketing", addr);
    const res = await adminQuery(
      "select count(*)::int as n from public.waitlist where lower(email) = lower($1)",
      [addr],
    );
    expect(res.rows[0].n).toBe(0);
  });
});

async function businessCounts(studioId: string) {
  const res = await adminQuery(
    `select
       (select count(*)::int from public.clients where studio_id = $1) as clients,
       (select count(*)::int from public.appointments where studio_id = $1) as appointments,
       (select count(*)::int from public.sessions s
          join public.clients c on c.id = s.client_id where c.studio_id = $1) as sessions,
       (select count(*)::int from public.client_intake_forms where studio_id = $1) as intakes`,
    [studioId],
  );
  return res.rows[0];
}

// ---------------------------------------------------------------------------
// 5. ORDER
// ---------------------------------------------------------------------------
describe("0185: queue order", () => {
  it("is oldest-first, with id resolving an identical joined_at deterministically", async () => {
    const scoped = await seedStudio("wait02-order");
    // Three rows sharing ONE transaction timestamp: now() is the transaction
    // clock, so all three land on the same joined_at and only the id tie-break
    // can order them.
    const ids = await adminTx(async (q) => {
      const out: string[] = [];
      for (const n of [1, 2, 3]) {
        const r = await q(
          "select entry_id from public.join_new_client_waitlist($1, $2, $3, null)",
          [scoped.studioId, `Tied ${n}`, email(`tie-${n}`)],
        );
        out.push(r.rows[0].entry_id as string);
      }
      return out;
    });

    const stamps = await adminQuery(
      "select count(distinct joined_at)::int as n from public.new_client_waitlist_entries where studio_id = $1",
      [scoped.studioId],
    );
    expect(stamps.rows[0].n, "the tie-break must actually be exercised").toBe(1);

    const ordered = await adminQuery(
      `select id from public.new_client_waitlist_entries
        where studio_id = $1 and status = 'waiting'
        order by joined_at asc, id asc`,
      [scoped.studioId],
    );
    expect(ordered.rows.map((r) => r.id)).toEqual([...ids].sort());

    // And it is STABLE: the same query twice returns the same sequence.
    const again = await adminQuery(
      `select id from public.new_client_waitlist_entries
        where studio_id = $1 and status = 'waiting'
        order by joined_at asc, id asc`,
      [scoped.studioId],
    );
    expect(again.rows.map((r) => r.id)).toEqual(ordered.rows.map((r) => r.id));
  });

  it("an older entry sorts ahead of a newer one", async () => {
    const scoped = await seedStudio("wait02-order-2");
    const first = await join(scoped.studioId, "Earlier", email("earlier"));
    const second = await join(scoped.studioId, "Later", email("later"));
    const ordered = await adminQuery(
      `select id from public.new_client_waitlist_entries
        where studio_id = $1 order by joined_at asc, id asc`,
      [scoped.studioId],
    );
    expect(ordered.rows.map((r) => r.id)).toEqual([first.entry_id, second.entry_id]);
  });
});

// ---------------------------------------------------------------------------
// 6. REMOVAL
// ---------------------------------------------------------------------------
describe("0185: removal", () => {
  it("waiting -> removed, recording who and when, WITHOUT deleting the row", async () => {
    const created = await join(a.studioId, "To Remove", email("to-remove"));
    expect(await remove(a.studioId, created.entry_id!, a.userId)).toBe("removed");

    const row = await adminQuery(
      "select status, removed_at, removed_by_practitioner_id from public.new_client_waitlist_entries where id = $1",
      [created.entry_id],
    );
    expect(row.rows).toHaveLength(1); // still there
    expect(row.rows[0].status).toBe("removed");
    expect(row.rows[0].removed_at).not.toBeNull();
    expect(row.rows[0].removed_by_practitioner_id).toBe(a.practitionerId);
  });

  it("a removed entry leaves the active queue", async () => {
    const scoped = await seedStudio("wait02-removal");
    const kept = await join(scoped.studioId, "Kept", email("kept"));
    const gone = await join(scoped.studioId, "Gone", email("gone"));
    await remove(scoped.studioId, gone.entry_id!, scoped.userId);

    const active = await adminQuery(
      "select id from public.new_client_waitlist_entries where studio_id = $1 and status = 'waiting'",
      [scoped.studioId],
    );
    expect(active.rows.map((r) => r.id)).toEqual([kept.entry_id]);
  });

  it("a NON-OWNER member of the studio is refused", async () => {
    const created = await join(a.studioId, "Member Cannot", email("member-cannot"));
    expect(await remove(a.studioId, created.entry_id!, aMember.userId)).toBe("not_owner");
    expect(await statusOf(created.entry_id!)).toBe("waiting");
  });

  it("ANOTHER studio's owner is refused before the entry is even looked at", async () => {
    const created = await join(a.studioId, "Cross Studio", email("cross-remove"));
    expect(await remove(a.studioId, created.entry_id!, b.userId)).toBe("not_a_member");
    expect(await statusOf(created.entry_id!)).toBe("waiting");
  });

  it("a cross-studio entry id under your OWN studio is simply not found", async () => {
    const created = await join(a.studioId, "Not Yours", email("not-yours"));
    expect(await remove(b.studioId, created.entry_id!, b.userId)).toBe("not_found");
    expect(await statusOf(created.entry_id!)).toBe("waiting");
  });

  it("an INACTIVE owner is refused", async () => {
    const scoped = await seedStudio("wait02-inactive");
    const created = await join(scoped.studioId, "Inactive Owner", email("inactive"));
    await adminQuery("update public.practitioners set active = false where id = $1", [
      scoped.practitionerId,
    ]);
    expect(await remove(scoped.studioId, created.entry_id!, scoped.userId)).toBe("not_a_member");
  });

  it("removing twice is idempotent and reported honestly", async () => {
    const created = await join(a.studioId, "Twice", email("twice"));
    expect(await remove(a.studioId, created.entry_id!, a.userId)).toBe("removed");
    expect(await remove(a.studioId, created.entry_id!, a.userId)).toBe("already_removed");
  });

  it("refuses null arguments rather than guessing", async () => {
    expect(await remove(a.studioId, randomUUID(), a.userId)).toBe("not_found");
    const res = await adminQuery(
      "select public.remove_new_client_waitlist_entry($1, null, $2) as outcome",
      [a.studioId, a.userId],
    );
    expect(res.rows[0].outcome).toBe("invalid_input");
  });
});

async function statusOf(entryId: string): Promise<string> {
  const res = await adminQuery(
    "select status from public.new_client_waitlist_entries where id = $1",
    [entryId],
  );
  return res.rows[0].status as string;
}

// ---------------------------------------------------------------------------
// 7. TRANSITION LAW
// ---------------------------------------------------------------------------
describe("0185: nothing can convert, move or rewrite an entry", () => {
  it("waiting -> converted is refused, even as the table owner", async () => {
    const created = await join(a.studioId, "No Conversion", email("no-conversion"));
    await expect(
      adminQuery(
        "update public.new_client_waitlist_entries set status = 'converted' where id = $1",
        [created.entry_id],
      ),
    ).rejects.toThrow(/only permitted status transition is waiting -> removed/);
  });

  it("removed -> waiting is refused: history is not resurrected", async () => {
    const created = await join(a.studioId, "No Undo", email("no-undo"));
    await remove(a.studioId, created.entry_id!, a.userId);
    await expect(
      adminQuery(
        `update public.new_client_waitlist_entries
            set status = 'waiting', removed_at = null, removed_by_practitioner_id = null
          where id = $1`,
        [created.entry_id],
      ),
    ).rejects.toThrow(/only permitted status transition/);
  });

  it("a row cannot be moved to another studio", async () => {
    const created = await join(a.studioId, "Stay Put", email("stay-put"));
    await expect(
      adminQuery(
        "update public.new_client_waitlist_entries set studio_id = $2 where id = $1",
        [created.entry_id, b.studioId],
      ),
    ).rejects.toThrow(/immutable/);
  });

  it("contact details are frozen — there is no correction path in this release", async () => {
    const created = await join(a.studioId, "Frozen", email("frozen"));
    for (const [column, value] of [
      ["name", "Someone Else"],
      ["email", "someone.else@harness.local"],
      ["phone", "555 0000"],
    ] as const) {
      await expect(
        adminQuery(
          `update public.new_client_waitlist_entries set ${column} = $2 where id = $1`,
          [created.entry_id, value],
        ),
        `${column} must be immutable`,
      ).rejects.toThrow(/contact details are immutable/);
    }
  });

  it("removal evidence cannot be forged onto a waiting row", async () => {
    const created = await join(a.studioId, "No Fake Evidence", email("fake-evidence"));
    await expect(
      adminQuery(
        "update public.new_client_waitlist_entries set removed_at = now() where id = $1",
        [created.entry_id],
      ),
      // Two independent layers refuse this: the BEFORE UPDATE trigger (which
      // fires first) and the all-or-nothing CHECK behind it.
    ).rejects.toThrow(/removal evidence is recorded once|removal_evidence_check/);
  });

  it("REMOVAL EVIDENCE IS WRITE-ONCE — it cannot be rewritten afterwards", async () => {
    // The gap this closes: an UPDATE on an already-removed row that leaves
    // `status` alone changes no other guarded field, satisfies the
    // all-or-nothing CHECK, and satisfies the composite FK for ANY same-studio
    // practitioner. Without this the file would call attribution durable while
    // enforcing nothing — the 0183 failure shape.
    const created = await join(a.studioId, "Durable Attribution", email("durable-attr"));
    expect(await remove(a.studioId, created.entry_id!, a.userId)).toBe("removed");

    for (const [label, sql, params] of [
      [
        "a different remover in the same studio",
        "update public.new_client_waitlist_entries set removed_by_practitioner_id = $2 where id = $1",
        [created.entry_id, aMember.practitionerId],
      ],
      [
        "a different removal time",
        "update public.new_client_waitlist_entries set removed_at = now() - interval '10 days' where id = $1",
        [created.entry_id],
      ],
      [
        "erasing the evidence entirely",
        "update public.new_client_waitlist_entries set removed_at = null, removed_by_practitioner_id = null where id = $1",
        [created.entry_id],
      ],
    ] as const) {
      await expect(
        adminQuery(sql, [...params]),
        `${label} must be refused`,
      ).rejects.toThrow(/removal evidence is recorded once|removal_evidence_check/);
    }

    // The original evidence is intact.
    const row = await adminQuery(
      "select removed_by_practitioner_id from public.new_client_waitlist_entries where id = $1",
      [created.entry_id],
    );
    expect(row.rows[0].removed_by_practitioner_id).toBe(a.practitionerId);
  });

  it("but the transition ITSELF still records evidence — the guard is not a block", async () => {
    // ANTI-VACUITY: a guard that refused the legal write too would pass every
    // assertion above and break the product.
    const created = await join(a.studioId, "Legal Removal", email("legal-removal"));
    expect(await remove(a.studioId, created.entry_id!, a.userId)).toBe("removed");
    const row = await adminQuery(
      "select removed_at, removed_by_practitioner_id from public.new_client_waitlist_entries where id = $1",
      [created.entry_id],
    );
    expect(row.rows[0].removed_at).not.toBeNull();
    expect(row.rows[0].removed_by_practitioner_id).toBe(a.practitionerId);
  });

  it("an unrelated UPDATE on a removed row is still allowed", async () => {
    // The guard is narrow: it freezes the two evidence columns, not the row.
    const created = await join(a.studioId, "Touch Removed", email("touch-removed"));
    await remove(a.studioId, created.entry_id!, a.userId);
    await expect(
      adminQuery(
        "update public.new_client_waitlist_entries set updated_at = now() where id = $1",
        [created.entry_id],
      ),
    ).resolves.toBeDefined();
  });

  it("an actor from ANOTHER studio cannot be recorded as the remover", async () => {
    const created = await join(a.studioId, "Wrong Actor", email("wrong-actor"));
    await expect(
      adminQuery(
        `update public.new_client_waitlist_entries
            set status = 'removed', removed_at = now(), removed_by_practitioner_id = $2
          where id = $1`,
        [created.entry_id, b.practitionerId],
      ),
    ).rejects.toThrow(/removed_by_same_studio_fk|foreign key/i);
  });
});

// ---------------------------------------------------------------------------
// 8. NEGATIVE CONTROL — the mutation, performed for real and rolled back
// ---------------------------------------------------------------------------
describe("0185: negative control", () => {
  it("the OLD status-only guard really did let removal evidence be rewritten", async () => {
    // Sensitivity check for the review finding, not a restatement of it. The
    // shipped guard freezes removed_at / removed_by_practitioner_id outside the
    // legal transition; the guard it replaced checked the status COLUMN only.
    //
    // If the earlier form had ALSO refused this write, the regression test
    // above would pass against both versions and prove nothing. So the old
    // function body is reinstalled for real, inside a transaction that is then
    // rolled back (DDL and function definitions are transactional in
    // PostgreSQL), and the rewrite is observed to SUCCEED.
    const created = await join(a.studioId, "Sensitivity", email("sensitivity"));
    expect(await remove(a.studioId, created.entry_id!, a.userId)).toBe("removed");

    const sentinel = new Error("intentional rollback");
    let rewriteSucceededUnderOldGuard = false;

    await expect(
      adminTx(async (q) => {
        await q(`
          create or replace function public.new_client_waitlist_entries_transition_guard()
          returns trigger
          language plpgsql
          set search_path = pg_catalog, pg_temp
          as $old$
          begin
            if new.id is distinct from old.id
               or new.studio_id is distinct from old.studio_id
               or new.joined_at is distinct from old.joined_at
               or new.source is distinct from old.source then
              raise exception 'immutable' using errcode = 'check_violation';
            end if;
            if new.name is distinct from old.name
               or new.email is distinct from old.email
               or new.phone is distinct from old.phone then
              raise exception 'immutable' using errcode = 'check_violation';
            end if;
            if new.status is distinct from old.status
               and not (old.status = 'waiting' and new.status = 'removed') then
              raise exception 'transition' using errcode = 'check_violation';
            end if;
            return new;
          end;
          $old$;
        `);

        const res = await q(
          `update public.new_client_waitlist_entries
              set removed_by_practitioner_id = $2, removed_at = now() - interval '10 days'
            where id = $1
            returning removed_by_practitioner_id`,
          [created.entry_id, aMember.practitionerId],
        );
        rewriteSucceededUnderOldGuard =
          res.rows.length === 1 &&
          res.rows[0].removed_by_practitioner_id === aMember.practitionerId;

        throw sentinel;
      }),
    ).rejects.toBe(sentinel);

    expect(
      rewriteSucceededUnderOldGuard,
      "the old guard must actually permit the rewrite — otherwise the write-once test proves nothing",
    ).toBe(true);

    // The shipped guard is back, and it still refuses.
    await expect(
      adminQuery(
        "update public.new_client_waitlist_entries set removed_by_practitioner_id = $2 where id = $1",
        [created.entry_id, aMember.practitionerId],
      ),
    ).rejects.toThrow(/removal evidence is recorded once/);

    // ...and the original attribution survived the whole exercise.
    const row = await adminQuery(
      "select removed_by_practitioner_id from public.new_client_waitlist_entries where id = $1",
      [created.entry_id],
    );
    expect(row.rows[0].removed_by_practitioner_id).toBe(a.practitionerId);
  });

  it("uniqueness WITHOUT studio scope breaks a legitimate cross-studio join", async () => {
    // The claim under test is that the STUDIO SCOPE in the shipped unique index
    // is what lets one person wait at two unrelated studios — not something
    // else in the schema that would keep the positive test green if the scoping
    // were removed.
    //
    // So the mutation is performed for real, inside a transaction that is then
    // rolled back (DDL is transactional in PostgreSQL, so nothing survives): a
    // unique index over email_normalized ALONE. It is narrowed by predicate to
    // the one address under test purely so it can be built at all — this
    // database legitimately already contains people waiting at two studios,
    // which is itself the point. Within that address it is exactly the
    // studio-blind rule the shipped index must never become.
    const addr = email("negative-control");
    const sentinel = new Error("intentional rollback");
    let crossStudioJoinFailed = false;

    await expect(
      adminTx(async (q) => {
        // DDL takes no bind parameters, so the predicate literal is inlined.
        // `addr` is generated by this file from a uuid; the assertion below
        // pins its shape so the interpolation can never carry anything else.
        expect(addr).toMatch(/^wait02-negative-control-[0-9a-f]{8}@harness\.local$/);
        await q(
          `create unique index new_client_waitlist_entries_studio_blind_mutation
             on public.new_client_waitlist_entries (email_normalized)
             where status = 'waiting' and email_normalized = '${addr}'`,
        );

        const first = await q(
          "select result from public.join_new_client_waitlist($1, 'Control A', $2, null)",
          [a.studioId, addr],
        );
        expect(first.rows[0].result).toBe("created");

        // Studio B's join is legitimate and independent. Under a studio-blind
        // rule it collides with studio A's row.
        try {
          await q(
            "select result from public.join_new_client_waitlist($1, 'Control B', $2, null)",
            [b.studioId, addr],
          );
        } catch (err) {
          crossStudioJoinFailed = /studio_blind_mutation|duplicate key/i.test(
            err instanceof Error ? err.message : String(err),
          );
        }
        throw sentinel;
      }),
    ).rejects.toBe(sentinel);

    expect(
      crossStudioJoinFailed,
      "with studio scope removed, studio B's independent join must fail — if it did not, the positive cross-studio test proves nothing",
    ).toBe(true);

    // The shipped schema is untouched, and the real behaviour still holds.
    const restored = await adminQuery(
      `select indexdef from pg_indexes
        where tablename = 'new_client_waitlist_entries'
          and indexname = 'new_client_waitlist_entries_one_waiting_per_email'`,
    );
    expect(restored.rows[0].indexdef).toContain("(studio_id, email_normalized)");
    const mutation = await adminQuery(
      `select count(*)::int as n from pg_indexes
        where tablename = 'new_client_waitlist_entries'
          and indexname = 'new_client_waitlist_entries_studio_blind_mutation'`,
    );
    expect(mutation.rows[0].n, "the mutation must not have survived").toBe(0);

    const fresh = email("negative-control-after");
    expect((await join(a.studioId, "After A", fresh)).result).toBe("created");
    expect((await join(b.studioId, "After B", fresh)).result).toBe("created");
  });
});
