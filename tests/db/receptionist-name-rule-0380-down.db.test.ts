import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, closePool } from "./helpers/harness";

// The 0380 rollback must not run over 0382.
//
// 0382 closes receptionist_client_directory and receptionist_client_contacts_v2 by PRIVILEGE ONLY and leaves their bodies exactly 0380's. The 0380 down file's
// preamble only checked the bodies, so it passed with 0382 in place and then re-granted EXECUTE to authenticated on both functions with the 0374 bodies, which
// return a client's full phone and email: the contact book re-opened to every receptionist, and nothing refused it. It now refuses (55000) before any change when
// authenticated cannot execute either function, and says to run the 0382 down file first.
//
// THE CASES, one stack, restored at the end:
//   1. at the head (0380 and 0382 applied) the 0380 down is REFUSED, naming 0382, and NOTHING changed: bodies, owner, ACLs and comments are identical afterwards;
//   2. the ordered way back works: the 0382 down, then the 0380 down. The result is the 0374 state: the 0374 bodies, EXECUTE for authenticated only;
//   3. that state is reproduced EXACTLY by a second trip (up files, then the ordered way back), so the way back restores one state, not whatever was left;
//   4. the head is restored by the up files.
// This test FAILS on the old down file: with 0382 in place it ran, and the ACL then differed from the closed one.
//
// SYNTHETIC: no client, studio or user row is created or read.

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const UP_0380 = read("supabase/migrations/0380_receptionist_name_rule.sql");
const DOWN_0380 = read("supabase/rollbacks/0380_receptionist_name_rule.down.sql");
const UP_0382 = read("supabase/migrations/0382_receptionist_close_older_contact_commands.sql");
const DOWN_0382 = read("supabase/rollbacks/0382_receptionist_close_older_contact_commands.down.sql");

const FUNCTIONS = ["receptionist_client_directory", "receptionist_calendar_v2", "receptionist_client_contacts_v2"] as const;
const CLOSED_BY_0382 = ["receptionist_client_directory", "receptionist_client_contacts_v2"] as const;
// The bodies 0374 installed, which the 0380 down restores (the md5s its own after-check requires).
const BODIES_0374: Record<string, string> = {
  receptionist_client_directory: "602bca224cc6ce50cab70c5692ea0902",
  receptionist_calendar_v2: "911df019f695523168b39fd6e43afbc7",
  receptionist_client_contacts_v2: "b157fca004345dddd4ad15586d92dc1d",
};

// Puts the database at the repository head (0380 AND 0382 applied) from whichever of the states these tests can leave it in. Idempotent: at the head it
// re-states the closed ACL and nothing else. Run before the cases (so a stack left half-way by an earlier run cannot fail them for the wrong reason) and in
// every finally (so a failing assertion cannot leave the next suite on the wrong state).
async function restoreHead() {
  const now = await snapshot();
  if (now.every((r) => r.md5 === BODIES_0374[r.name])) await adminQuery(UP_0380);
  await adminQuery(UP_0382);
}

beforeAll(async () => {
  await restoreHead();
});

afterAll(async () => {
  await closePool();
});

type Snap = { name: string; md5: string; owner: string; config: string; acl: string; comment: string; authenticated: boolean; anon: boolean; service: boolean }[];

async function snapshot(): Promise<Snap> {
  const { rows } = await adminQuery(
    `select p.proname::text as name, pg_catalog.md5(p.prosrc) as md5, pg_catalog.pg_get_userbyid(p.proowner)::text as owner,
            coalesce(p.proconfig::text, '') as config, coalesce(p.proacl::text, '<default>') as acl,
            coalesce(pg_catalog.obj_description(p.oid, 'pg_proc'), '') as comment,
            pg_catalog.has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
            pg_catalog.has_function_privilege('anon', p.oid, 'execute') as anon,
            pg_catalog.has_function_privilege('service_role', p.oid, 'execute') as service
       from pg_catalog.pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname = any ($1::text[])
      order by 1`,
    [[...FUNCTIONS]],
  );
  return rows as Snap;
}

const wayBack = async () => {
  await adminQuery(DOWN_0382);
  await adminQuery(DOWN_0380);
};

describe("the 0380 down file is guarded against 0382", () => {
  it("is refused with 0382 in place, changes nothing, and the ordered way back restores the 0374 state exactly", async () => {
    const head = await snapshot();
    expect(head.map((r) => r.name)).toEqual([...FUNCTIONS].sort());
    // POSITIVE CONTROL of the setup: this really is the 0382 state, so the refusal below is the guard and not a coincidence.
    for (const r of head) {
      const closed = (CLOSED_BY_0382 as readonly string[]).includes(r.name);
      expect(r.authenticated, `${r.name}: authenticated can execute only when 0382 did not close it`).toBe(!closed);
    }

    try {
      // 1. REFUSED, naming 0382, with nothing changed (one transaction, so the refusal rolls back whatever came first).
      await expect(adminQuery(DOWN_0380)).rejects.toMatchObject({ code: "55000", message: expect.stringMatching(/0380 down refuses to run: authenticated cannot execute .*0382 .*Run the 0382 down file first/) });
      expect(await snapshot()).toEqual(head);

      // 2. The ordered way back: 0382's down, then 0380's. The 0374 bodies, EXECUTE for authenticated only, nothing for anon or service_role.
      await wayBack();
      const at0374 = await snapshot();
      for (const r of at0374) {
        expect(r.md5, `${r.name} is the 0374 body`).toBe(BODIES_0374[r.name]);
        expect(r.authenticated, `${r.name}: authenticated`).toBe(true);
        expect(r.anon, `${r.name}: anon`).toBe(false);
        expect(r.service, `${r.name}: service_role`).toBe(false);
      }

      // 3. A second trip lands on the SAME state, byte for byte: bodies, owner, config, ACL text and comments.
      await adminQuery(UP_0380);
      await adminQuery(UP_0382);
      expect(await snapshot()).toEqual(head);
      await wayBack();
      expect(await snapshot()).toEqual(at0374);
    } finally {
      // 4. Restore the head whatever happened above.
      await restoreHead();
    }
    expect(await snapshot()).toEqual(head);
  });

  it("the 0380 down alone is also refused when only ONE of the two functions is closed", async () => {
    const head = await snapshot();
    try {
      // Re-open the directory only: the contacts finder stays closed, which is still the signature of 0382.
      await adminQuery(`grant execute on function public.receptionist_client_directory(uuid, text, text[], text, integer, integer) to authenticated`);
      const partial = await snapshot();
      await expect(adminQuery(DOWN_0380)).rejects.toMatchObject({ code: "55000", message: expect.stringMatching(/receptionist_client_contacts_v2/) });
      expect(await snapshot()).toEqual(partial);
    } finally {
      await restoreHead();
    }
    expect(await snapshot()).toEqual(head);
  });
});
