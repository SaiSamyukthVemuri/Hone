import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isRepoMax } from "./helpers/migration-state";

// SOURCE CONTRACT for 0358 (per-number SMS consent evidence and the phone-wide STOP list). Behaviour is proven against a
// real database in tests/db/sms-number-consent-evidence.db.test.ts; this file pins the shape that must not drift and the
// route wiring that makes a STOP remembered per number.

const FILE = "supabase/migrations/0358_sms_number_consent_evidence.sql";
const sql = readFileSync(FILE, "utf8");
const route = readFileSync("app/api/twilio/inbound-sms/route.ts", "utf8");

describe("0358 source contract", () => {
  it("is the current maximum migration", () => {
    expect(isRepoMax("0358")).toBe(true);
  });

  it("opens its own transaction and arms lock_timeout inside it", () => {
    expect(sql).toMatch(/^begin;\s*\nset local lock_timeout = '5s';/m);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("both tables are RLS-on with every privilege revoked from every application role", () => {
    for (const t of ["sms_number_consents", "sms_number_opt_outs"]) {
      expect(sql).toContain(`alter table public.${t} enable row level security;`);
      expect(sql).toContain(`revoke all on public.${t} from public, anon, authenticated, service_role;`);
    }
    expect(sql).not.toMatch(/grant\s+(select|insert|update|delete|all)[^;]*on\s+public\.sms_number_/i);
  });

  it("consents cascade with the studio, client and entry; the opt-out list has no foreign key at all", () => {
    expect(sql).toMatch(/studio_id\s+uuid not null references public\.studios\(id\) on delete cascade/);
    expect(sql).toMatch(/client_id\s+uuid references public\.clients\(id\) on delete cascade/);
    expect(sql).toMatch(/waitlist_entry_id\s+uuid references public\.new_client_waitlist_entries\(id\) on delete cascade/);
    const optOut = sql.slice(sql.indexOf("create table public.sms_number_opt_outs"), sql.indexOf("alter table public.sms_number_consents"));
    expect(optOut).not.toMatch(/references/);
  });

  it("is append-only: consents refuse update, opt-outs refuse update and delete", () => {
    expect(sql).toMatch(/sms_number_consents_no_update\s+before update on public\.sms_number_consents/);
    expect(sql).toMatch(/sms_number_opt_outs_no_change\s+before update or delete on public\.sms_number_opt_outs/);
  });

  it("both functions are revoked from all four roles by name and granted to service_role only", () => {
    for (const fn of ["record_sms_number_opt_out(text, text)", "waitlist_sms_number_consented(uuid, text)"]) {
      expect(sql).toContain(`revoke execute on function public.${fn} from public, anon, authenticated, service_role;`);
      expect(sql).toContain(`grant  execute on function public.${fn} to service_role;`);
    }
  });

  it("every function pins search_path", () => {
    const fns = sql.match(/create function [\s\S]*?\$\$;/g) ?? [];
    expect(fns.length).toBeGreaterThanOrEqual(5);
    for (const f of fns) expect(f).toMatch(/set search_path = ''/);
  });

  it("changes no existing gate: no existing function is redefined", () => {
    expect(sql).not.toMatch(/create or replace function/i);
    expect(sql).not.toMatch(/drop function/i);
  });
});

describe("the STOP route remembers the number", () => {
  it("calls record_sms_number_opt_out with the sender and the twilio_stop source", () => {
    expect(route).toMatch(/rpc\("record_sms_number_opt_out",\s*\{\s*p_phone: from,\s*p_source: "twilio_stop",?\s*\}\)/);
  });

  it("a failure to remember is a retry (500), decided with the other opt-out failures", () => {
    expect(route).toMatch(/prospectScanFailed \|\|\s*\n\s*numberOptOutFailed/);
  });
});

describe("no later migration redefines the evidence tables silently", () => {
  it("only 0358 creates them", () => {
    const creators = readdirSync("supabase/migrations").filter((f) =>
      /create table public\.sms_number_(consents|opt_outs)/.test(readFileSync(`supabase/migrations/${f}`, "utf8")),
    );
    expect(creators).toEqual(["0358_sms_number_consent_evidence.sql"]);
  });
});
