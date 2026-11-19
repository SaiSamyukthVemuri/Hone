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

describe("0358 pins the rules a quiet edit would weaken", () => {
  const helper = sql.slice(sql.indexOf("create function public.waitlist_sms_number_consented"), sql.indexOf("revoke execute on function public.record_sms_number_opt_out"));
  const backfill = sql.slice(sql.indexOf("-- 5. Backfill"), sql.indexOf("-- 6. A waitlist consent needs a number"));

  it("the consent check is VALIDATED in the same migration, after it is added NOT VALID", () => {
    expect(sql).toMatch(/add constraint new_client_waitlist_entries_consent_needs_phone_ck\s+check \(sms_consent_at is null or phone is not null\) not valid;/);
    expect(sql).toMatch(/validate constraint new_client_waitlist_entries_consent_needs_phone_ck;/);
    expect(sql.indexOf("not valid;")).toBeLessThan(sql.indexOf("validate constraint"));
  });

  it("an opt-out beats a consent in the helper: the opt-out test comes first and returns false", () => {
    const optOut = helper.indexOf("from public.sms_number_opt_outs");
    const consent = helper.indexOf("from public.sms_number_consents");
    expect(optOut).toBeGreaterThan(-1);
    expect(consent).toBeGreaterThan(optOut);
    expect(helper).toMatch(/if exists \(select 1 from public\.sms_number_opt_outs o where o\.phone_e164 = v_number\) then\s+return false;\s+end if;/);
  });

  it("the backfill keeps the EARLIEST opt-out time and its two source labels", () => {
    expect(backfill).toMatch(/select n, min\(at\), 'carried_forward'/);
    expect(backfill).not.toMatch(/max\(at\)/);
    expect(backfill).toContain("'carried_forward_waitlist'");
    expect(backfill).toMatch(/on conflict do nothing;[\s\S]*on conflict do nothing;/);
  });

  it("both writers fire on INSERT and on UPDATE of consent, opt-out and phone, and handle both operations", () => {
    expect(sql).toMatch(/after insert or update of sms_consent_at, sms_opted_out_at, phone on public\.clients/);
    expect(sql).toMatch(/after insert or update of sms_consent_at, sms_opted_out_at, phone on public\.new_client_waitlist_entries/);
    expect(sql.match(/tg_op = 'INSERT' or old\.sms_(consent|opted_out)_at is null/g)?.length).toBe(4);
  });

  it("TRUNCATE is refused by statement-level guards on both tables", () => {
    for (const t of ["sms_number_consents", "sms_number_opt_outs"]) {
      expect(sql).toMatch(new RegExp(`before truncate on public\\.${t}\\s+for each statement execute function public\\.sms_number_evidence_append_only\\(\\)`));
    }
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
