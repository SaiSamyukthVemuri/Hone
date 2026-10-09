import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { lookupPhoneWideSuppression } from "@/lib/sms/phone-suppression-lookup";

// ===========================================================================
// 0208 — THE PHONE-WIDE READ, AND THAT IT FAILS CLOSED
// ===========================================================================
//
// The two candidate sources are the STOP route's own: opted-out `clients`, and
// prospects through 0202's `waitlist_prospect_suppression_candidates`. What
// this proves is the wiring: both sources are consulted, only stamped prospects
// count, the read is the opted-out one, and ANY failure answers `ok: false`,
// never "not suppressed".

const OPTED_OUT = "2026-09-01T10:00:00.000Z";

type Reply = { data: unknown; error: { code?: string } | null };

function fakeAdmin(opts: {
  clients?: Reply | "throw";
  prospects?: Reply | "throw";
}) {
  const reads: Array<{ table: string; select: string; filters: unknown[][] }> = [];
  const rpcs: string[] = [];
  const admin = {
    from(table: string) {
      const read = { table, select: "", filters: [] as unknown[][] };
      reads.push(read);
      const builder = {
        select(columns: string) {
          read.select = columns;
          return builder;
        },
        not(...args: unknown[]) {
          read.filters.push(["not", ...args]);
          return builder;
        },
        then(resolve: (value: Reply) => unknown, reject: (reason: unknown) => unknown) {
          if (opts.clients === "throw") return Promise.reject(new Error("socket hang up")).then(resolve, reject);
          return Promise.resolve(opts.clients ?? { data: [], error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
    rpc(name: string) {
      rpcs.push(name);
      if (opts.prospects === "throw") return Promise.reject(new Error("socket hang up"));
      return Promise.resolve(opts.prospects ?? { data: [], error: null });
    },
  };
  return { admin: admin as unknown as SupabaseClient, reads, rpcs };
}

describe("lookupPhoneWideSuppression", () => {
  it("reads opted-out clients and the prospect candidates, nothing else", async () => {
    const { admin, reads, rpcs } = fakeAdmin({});
    expect(await lookupPhoneWideSuppression(admin, "+14165550100")).toEqual({
      ok: true,
      suppressed: false,
    });
    expect(reads).toEqual([
      {
        table: "clients",
        select: "id, studio_id, phone, sms_opted_out_at",
        filters: [
          ["not", "phone", "is", null],
          ["not", "sms_opted_out_at", "is", null],
        ],
      },
    ]);
    expect(rpcs).toEqual(["waitlist_prospect_suppression_candidates"]);
  });

  it("a client who said STOP in ANOTHER studio suppresses the number", async () => {
    const { admin } = fakeAdmin({
      clients: {
        data: [{ id: "c", studio_id: "studio-b", phone: "(416) 555-0100", sms_opted_out_at: OPTED_OUT }],
        error: null,
      },
    });
    expect(await lookupPhoneWideSuppression(admin, "+1 416 555 0100")).toEqual({
      ok: true,
      suppressed: true,
    });
  });

  it("a prospect counts only once stamped: the candidates list includes unstamped rows", async () => {
    const prospect = { id: "p", studio_id: "studio-b", phone: "+14165550100" };
    const unstamped = fakeAdmin({
      prospects: { data: [{ ...prospect, sms_opted_out_at: null }], error: null },
    });
    expect(await lookupPhoneWideSuppression(unstamped.admin, "+14165550100")).toEqual({
      ok: true,
      suppressed: false,
    });
    const stamped = fakeAdmin({
      prospects: { data: [{ ...prospect, sms_opted_out_at: OPTED_OUT }], error: null },
    });
    expect(await lookupPhoneWideSuppression(stamped.admin, "+14165550100")).toEqual({
      ok: true,
      suppressed: true,
    });
  });

  it("FAILS CLOSED: an error or a throw from either source is `ok: false`, never `not suppressed`", async () => {
    for (const opts of [
      { clients: { data: null, error: { code: "57014" } } },
      { prospects: { data: null, error: { code: "PGRST202" } } },
      { clients: "throw" as const },
      { prospects: "throw" as const },
    ]) {
      const { admin } = fakeAdmin(opts);
      expect(await lookupPhoneWideSuppression(admin, "+14165550100"), JSON.stringify(opts)).toEqual({
        ok: false,
      });
    }
  });
});
