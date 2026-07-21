import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asRole, closePool, seedStudio } from "./helpers/harness";

// Migration 0141 — truthful welcome-email attempt state machine. Proves the
// atomic single-flight claim (concurrent resends / rapid double-clicks collapse
// to one live attempt), the compare-and-set result stamp (a stale attempt can
// never overwrite a newer one, and only a real send stamps last_sent_at), and
// that only the trusted service-role adapter can claim or record.

afterAll(async () => {
  await closePool();
});

// Returns the minted attempt_id (uuid string) on a win, or null when a live
// attempt already owns the send.
async function claim(studioId: string): Promise<string | null> {
  const r = await adminQuery(
    `select public.claim_welcome_email_attempt($1) as c`,
    [studioId],
  );
  return r.rows[0].c ?? null;
}

async function record(
  studioId: string,
  attemptId: string,
  status: "not_sent" | "sent" | "failed",
): Promise<boolean> {
  const r = await adminQuery(
    `select public.record_welcome_email_result($1, $2, $3) as applied`,
    [studioId, attemptId, status],
  );
  return r.rows[0].applied === true;
}

async function readState(studioId: string) {
  const r = await adminQuery(
    `select welcome_email_status, welcome_email_attempt_id,
            welcome_email_last_attempted_at, welcome_email_last_sent_at
       from public.studio_onboarding where studio_id=$1`,
    [studioId],
  );
  return r.rows[0];
}

describe("claim_welcome_email_attempt — single attempt", () => {
  it("first claim mints an attempt_id and flips to 'sending'", async () => {
    const s = await seedStudio("claim-1");
    const id = await claim(s.studioId);
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    const st = await readState(s.studioId);
    expect(st.welcome_email_status).toBe("sending");
    expect(st.welcome_email_attempt_id).toBe(id);
    expect(st.welcome_email_last_attempted_at).not.toBeNull();
    // Claiming is NOT sending: last_sent_at stays null until a real send stamps.
    expect(st.welcome_email_last_sent_at).toBeNull();
  });

  it("an immediate second claim is refused while the first is live (debounced)", async () => {
    const s = await seedStudio("claim-1b");
    const first = await claim(s.studioId);
    expect(first).not.toBeNull();
    expect(await claim(s.studioId)).toBeNull();
  });

  it("two concurrent claims -> exactly one attempt_id is minted", async () => {
    const s = await seedStudio("claim-2");
    const [a, b] = await Promise.all([claim(s.studioId), claim(s.studioId)]);
    expect([a, b].filter((x) => x !== null)).toHaveLength(1);
  });

  it("a new claim is allowed once the prior attempt resolved (result recorded)", async () => {
    const s = await seedStudio("claim-3");
    const first = await claim(s.studioId);
    expect(first).not.toBeNull();
    // Resolve the first attempt (send failed) — status leaves 'sending'.
    expect(await record(s.studioId, first as string, "failed")).toBe(true);
    // A retry may now claim a fresh attempt_id distinct from the first.
    const second = await claim(s.studioId);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });
});

describe("record_welcome_email_result — compare-and-set on attempt_id", () => {
  it("the current attempt stamps 'sent' and sets last_sent_at", async () => {
    const s = await seedStudio("record-1");
    const id = (await claim(s.studioId)) as string;
    expect(await record(s.studioId, id, "sent")).toBe(true);
    const st = await readState(s.studioId);
    expect(st.welcome_email_status).toBe("sent");
    expect(st.welcome_email_last_sent_at).not.toBeNull();
  });

  it("a stale attempt_id CANNOT overwrite a newer attempt's result", async () => {
    const s = await seedStudio("record-2");
    const stale = (await claim(s.studioId)) as string;
    // The stale attempt failed; that resolves it so a retry can claim.
    expect(await record(s.studioId, stale, "failed")).toBe(true);
    const fresh = (await claim(s.studioId)) as string;
    expect(fresh).not.toBe(stale);
    // The fresh attempt sends successfully.
    expect(await record(s.studioId, fresh, "sent")).toBe(true);
    // The stale attempt now reports late — it must NOT clobber 'sent'.
    expect(await record(s.studioId, stale, "failed")).toBe(false);
    const st = await readState(s.studioId);
    expect(st.welcome_email_status).toBe("sent");
    expect(st.welcome_email_attempt_id).toBe(fresh);
  });

  it("'not_sent' reverts status without stamping last_sent_at", async () => {
    const s = await seedStudio("record-3");
    const id = (await claim(s.studioId)) as string;
    expect(await record(s.studioId, id, "not_sent")).toBe(true);
    const st = await readState(s.studioId);
    expect(st.welcome_email_status).toBe("not_sent");
    expect(st.welcome_email_last_sent_at).toBeNull();
  });

  it("rejects an out-of-set status value", async () => {
    const s = await seedStudio("record-4");
    const id = (await claim(s.studioId)) as string;
    await expect(record(s.studioId, id, "sending" as never)).rejects.toThrow();
  });
});

describe("welcome-email state machine — authorization", () => {
  it("anon cannot execute the claim", async () => {
    await expect(
      asRole("anon", (q) =>
        q(`select public.claim_welcome_email_attempt($1)`, [randomUUID()]),
      ),
    ).rejects.toThrow(/permission denied|not allowed|42501/i);
  });

  it("an authenticated browser role cannot execute the claim", async () => {
    await expect(
      asRole("authenticated", (q) =>
        q(`select public.claim_welcome_email_attempt($1)`, [randomUUID()]),
      ),
    ).rejects.toThrow(/permission denied|not allowed|42501/i);
  });

  it("an authenticated browser role cannot execute the result stamp", async () => {
    await expect(
      asRole("authenticated", (q) =>
        q(`select public.record_welcome_email_result($1, $2, $3)`, [
          randomUUID(),
          randomUUID(),
          "sent",
        ]),
      ),
    ).rejects.toThrow(/permission denied|not allowed|42501/i);
  });
});
