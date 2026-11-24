import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { adminQuery, closePool } from "./helpers/harness";

// The 0374 rollback must not run over a LATER body of the three receptionist read functions.
//
// 0380 replaces those bodies. The 0374 down file restores the pre-0374 bodies, which return the stored client name to a receptionist. Before its
// preamble it succeeded over 0380's bodies and silently re-opened that leak. It now refuses (55000) unless each function still has exactly the body
// 0374 installed.
//
// THE CASES, in one stack, restored at the end (so later suites on this stack find the head state again):
//   1. at the repository head (0380 applied) the down refuses, and NOTHING changed: bodies, volatility, owner, ACLs are identical afterwards;
//   2. with only 0374 applied (0380 rolled back by its own down file) the down runs, and the bodies are the pre-0374 ones;
//   3. the head state is restored by applying the up files again, and the ACL closed by the later closure migration is re-closed.
//
// SYNTHETIC: no client, studio or user row is created or read.

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const UP_0374 = read("supabase/migrations/0374_receptionist_name_rule.sql");
const DOWN_0374 = read("supabase/rollbacks/0374_receptionist_name_rule.down.sql");
const UP_0380 = read("supabase/migrations/0380_receptionist_name_rule.sql");
const DOWN_0380 = read("supabase/rollbacks/0380_receptionist_name_rule.down.sql");
const UP_0382 = read("supabase/migrations/0382_receptionist_close_older_contact_commands.sql");

const FUNCTIONS = ["receptionist_client_directory", "receptionist_calendar_v2", "receptionist_client_contacts_v2"] as const;
// The bodies on the hosted database before 0374 (the md5s 0374's own preamble requires).
const PRE_0374_MD5: Record<string, string> = {
  receptionist_client_directory: "d2cb9ea68f5696213cc8bf98b4cd58a4",
  receptionist_calendar_v2: "e826a57397d3609874b6687cf659fc0d",
  receptionist_client_contacts_v2: "116bad9455089d32ec7ee14310ed5a7b",
};

afterAll(async () => {
  await closePool();
});

type Snap = { name: string; md5: string; definer: boolean; vol: string; owner: string; config: string; acl: string }[];

async function snapshot(): Promise<Snap> {
  const { rows } = await adminQuery(
    `select p.proname::text as name, pg_catalog.md5(p.prosrc) as md5, p.prosecdef as definer, p.provolatile::text as vol,
            pg_catalog.pg_get_userbyid(p.proowner)::text as owner, coalesce(p.proconfig::text, '') as config, coalesce(p.proacl::text, '<default>') as acl
       from pg_catalog.pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname = any ($1::text[])
      order by 1`,
    [[...FUNCTIONS]],
  );
  return rows as Snap;
}

const bodiesOf = (s: Snap) => Object.fromEntries(s.map((r) => [r.name, r.md5]));

describe("the 0374 down file is guarded against a later body", () => {
  it("refuses at the head (0380 applied), changes nothing, then runs when only 0374 is applied, and the head state is restored", async () => {
    const head = await snapshot();
    expect(head.map((r) => r.name)).toEqual([...FUNCTIONS].sort());
    // POSITIVE CONTROL of the setup: the head bodies are NOT the ones 0374 installed and NOT the pre-0374 ones, so the refusal below is the guard and not a coincidence.
    for (const r of head) expect(r.md5, `${r.name} head body is not the pre-0374 body`).not.toBe(PRE_0374_MD5[r.name]);

    try {
      // 1. REFUSED, with the dedicated error code, and nothing changed (the whole file is one transaction, so a refusal rolls back).
      await expect(adminQuery(DOWN_0374)).rejects.toMatchObject({ code: "55000", message: expect.stringMatching(/0374 down refuses to run/) });
      expect(await snapshot()).toEqual(head);

      // 2. Bring the database to "only 0374 applied" with 0380's own down file, then the 0374 down must run.
      await adminQuery(DOWN_0380);
      const at0374 = await snapshot();
      for (const r of at0374) expect(r.md5, `${r.name} is not the head body after the 0380 down`).not.toBe(bodiesOf(head)[r.name]);
      await adminQuery(DOWN_0374);
      const rolled = await snapshot();
      expect(bodiesOf(rolled)).toEqual(PRE_0374_MD5);
      for (const r of rolled) {
        expect(r.definer, `${r.name} stays security definer`).toBe(true);
        expect(r.config, `${r.name} keeps its pinned search_path`).toContain("search_path=pg_catalog, pg_temp");
      }
    } finally {
      // 3. Restore the head: 0374, 0380, and the closure migration (re-applying the 0374 file re-states EXECUTE for authenticated on all three).
      await adminQuery(UP_0374);
      await adminQuery(UP_0380);
      await adminQuery(UP_0382);
    }
    expect(await snapshot()).toEqual(head);
  });
});
