import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, closePool } from "./helpers/harness";
import {
  dropSynthStudio,
  seedSynthStudioA,
  seedSynthStudioB,
  seedSynthStudioC,
  type SynthStudio,
} from "./helpers/synth-fleet";

// SAFE-SYNTH foundation test: the cross-tenant boundary. Studio A's
// authenticated owner must not read, modify, or write into Studio B's data
// through RLS. This is the negative-boundary primitive every later
// tenant/provider P1 test reuses (Wave 6 boundary matrix, etc.). Runs against
// the REAL migrated schema on the local Supabase stack (db-integration lane).

let A: SynthStudio;
let B: SynthStudio;

beforeAll(async () => {
  A = await seedSynthStudioA();
  B = await seedSynthStudioB();
});

afterAll(async () => {
  if (A) await dropSynthStudio(A);
  if (B) await dropSynthStudio(B);
  await closePool();
});

describe("SAFE-SYNTH fleet seeds distinct synthetic tenants", () => {
  it("Studio A is solo, Studio B has three practitioners", () => {
    expect(A.practitioners).toHaveLength(1);
    expect(A.practitioners[0].role).toBe("owner");
    expect(B.practitioners).toHaveLength(3);
    expect(B.practitioners.filter((p) => p.role === "owner")).toHaveLength(1);
    expect(B.practitioners.filter((p) => p.role === "practitioner")).toHaveLength(2);
  });

  it("uses recognizable synthetic identifiers only", () => {
    expect(A.name).toBe("SYNTH-A");
    expect(B.name).toBe("SYNTH-B");
    for (const p of [...A.practitioners, ...B.practitioners]) {
      expect(p.email.endsWith("@synth.local")).toBe(true);
    }
    expect(A.studioId).not.toBe(B.studioId);
  });
});

describe("cross-tenant isolation: Studio A cannot reach Studio B", () => {
  it("A's owner reads zero of B's clients (RLS scopes to own studio)", async () => {
    const rows = await asUser(A.userId, (q) =>
      q(`select id from public.clients where studio_id = $1`, [B.studioId]),
    );
    expect(rows.rowCount).toBe(0);
  });

  it("A's owner cannot fetch B's specific client by id", async () => {
    const rows = await asUser(A.userId, (q) =>
      q(`select id from public.clients where id = $1`, [B.clientId]),
    );
    expect(rows.rowCount).toBe(0);
  });

  it("A's owner cannot UPDATE B's client (0 rows affected)", async () => {
    const res = await asUser(A.userId, (q) =>
      q(`update public.clients set name = 'HIJACK' where id = $1`, [B.clientId]),
    );
    expect(res.rowCount).toBe(0);
  });

  it("A's owner cannot INSERT a client into B's studio (RLS WITH CHECK denies)", async () => {
    await expect(
      asUser(A.userId, (q) =>
        q(`insert into public.clients (studio_id, name) values ($1, $2)`, [
          B.studioId,
          "SYNTH-A intruder",
        ]),
      ),
    ).rejects.toThrow();
  });

  it("positive control: B's owner CAN read B's own client", async () => {
    const rows = await asUser(B.userId, (q) =>
      q(`select id from public.clients where id = $1`, [B.clientId]),
    );
    expect(rows.rowCount).toBe(1);
  });
});

describe("Studio C carries an injectable failure mode", () => {
  it("records the requested failure mode without side effects", async () => {
    const C = await seedSynthStudioC("revoked_oauth");
    try {
      expect(C.failureMode).toBe("revoked_oauth");
      expect(C.name).toBe("SYNTH-C");
    } finally {
      await dropSynthStudio(C);
    }
  });
});
