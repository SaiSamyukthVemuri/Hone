import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isRepoMax } from "./helpers/migration-state";

// 0394: the visit payment commands. Source contract; behaviour is proved in tests/db/visit-payment-commands.db.test.ts.
const UP = readFileSync("supabase/migrations/0394_visit_payment_commands.sql", "utf8");
const DOWN = readFileSync("supabase/rollbacks/0394_visit_payment_commands.down.sql", "utf8");
const code = (s: string) => s.replace(/--[^\n]*/g, "");
const COMMANDS = [
  "ensure_visit_bill(uuid, uuid, integer, text, boolean)",
  "record_visit_external_payment(uuid, uuid, text, integer, uuid, text)",
  "confirm_visit_external_payment(uuid, uuid)",
  "void_visit_external_payment(uuid, uuid, text)",
  "request_payment_refund(uuid, uuid, uuid, uuid, integer, text, text, uuid)",
  "finish_payment_refund(uuid, text, text, text, text, text, integer)",
  "get_visit_payment_position(uuid, uuid)",
];

describe("0394 is shaped like a sealed migration", () => {
  it("is the repository's newest migration (this file is the current maximum's own test)", () => expect(isRepoMax("0394")).toBe(true));

  it("opens its own transaction and arms lock_timeout inside it, in the up and the down", () => {
    for (const f of [UP, DOWN]) {
      expect(f).toMatch(/^begin;$/m);
      expect(f).toMatch(/^commit;$/m);
      expect(f.indexOf("begin;")).toBeLessThan(f.indexOf("set local lock_timeout"));
    }
  });

  it("revokes every command from public, anon, authenticated AND service_role by name before any grant", () => {
    const c = code(UP);
    for (const sig of COMMANDS) {
      const esc = sig.replace(/[()]/g, "\\$&");
      expect(c, sig).toMatch(new RegExp(`revoke all privileges on function public\\.${esc} from public, anon, authenticated, service_role;`));
      expect(c.indexOf(`revoke all privileges on function public.${sig}`), sig).toBeLessThan(c.indexOf(`grant execute on function public.${sig}`));
    }
    expect(c).not.toMatch(/grant [^;]*\bto (anon|public)\b/);
    expect(c).toMatch(/grant execute on function public\.finish_payment_refund\([^)]*\) to service_role;/);
  });

  it("every money decision takes the visit's settlement advisory lock first", () => {
    const c = code(UP);
    for (const fn of ["ensure_visit_bill", "record_visit_external_payment", "confirm_visit_external_payment", "void_visit_external_payment", "request_payment_refund", "finish_payment_refund", "payment_charge_attempts_visit_bill_guard"]) {
      const at = c.indexOf(`function public.${fn}(`);
      const end = c.indexOf("$$;", c.indexOf("$$", at) + 2);
      expect(c.slice(at, end), fn).toContain("pg_advisory_xact_lock(public.appointment_settlement_lock_key(");
    }
  });

  it("the card wall refuses BEFORE any Stripe call: it is a BEFORE INSERT trigger on the attempt, with distinct error codes", () => {
    const c = code(UP);
    expect(c).toMatch(/create trigger payment_charge_attempts_visit_bill_guard_trg before insert on public\.payment_charge_attempts/);
    expect(c).toContain("errcode = 'PY001'");
    expect(c).toContain("This amount is reserved for a pending transfer");
    expect(c).toContain("errcode = 'PY002'");
  });

  it("the settlement wall: a BEFORE INSERT trigger on appointment_settlements takes the visit lock then refuses (PY004) when a live bill exists; the down file drops it", () => {
    const c = code(UP);
    const at = c.indexOf("function public.appointment_settlements_visit_bill_guard(");
    const end = c.indexOf("$$;", c.indexOf("$$", at) + 2);
    const body = c.slice(at, end);
    expect(body.indexOf("pg_advisory_xact_lock(")).toBeGreaterThan(-1);
    expect(body.indexOf("pg_advisory_xact_lock(")).toBeLessThan(body.indexOf("from public.visit_bills"));
    expect(body).not.toContain("superseded_at");            // ANY bill row refuses, live or superseded
    expect(body).toContain("errcode = 'PY004'");
    expect(c).toMatch(/create trigger appointment_settlements_visit_bill_guard_trg before insert on public\.appointment_settlements/);
    expect(c).toMatch(/revoke all privileges on function public\.appointment_settlements_visit_bill_guard\(\) from public, anon, authenticated, service_role/);
    expect(DOWN).toContain("drop trigger appointment_settlements_visit_bill_guard_trg on public.appointment_settlements;");
    expect(DOWN).toContain("drop function public.appointment_settlements_visit_bill_guard();");
  });

  it("a pending transfer is counted as reserved, and the old one-attempt rule is kept only for visits without a bill", () => {
    const c = code(UP);
    expect(c).toContain("filter (where e.state = 'pending_confirmation')");
    // PRODUCT RULE (27 Nov 2026): only a succeeded price_reduction frees capacity; a payment_reversal never reopens a balance.
    expect(c).toMatch(/greatest\(0, b\.total_cents - x\.confirmed - x\.pending - c\.card \+ d\.reduced\)/);
    expect(c).toMatch(/kind = 'price_reduction'/);
    expect(c).toMatch(/and visit_bill_id is null;/);
  });

  it("the split_payments key is pilot-only, and the 0187 settlement commands are not redefined", () => {
    const c = code(UP);
    expect(c).toContain("key <> 'split_payments' or mode in ('off', 'pilot')");
    expect(c).not.toMatch(/function public\.(record_appointment_settlement|record_adjusted_appointment_settlement)/);
  });

  it("studio_has_gone_live is the ONE rule for which card money counts: derived from rows, used by the position, never a caller input", () => {
    const c = code(UP);
    expect(c).toMatch(/function public\.studio_has_gone_live\(p_studio uuid\)/);
    expect(c).toMatch(/a\.stripe_livemode = true and a\.status = 'succeeded'/);
    expect(c).toMatch(/function public\.card_counts_toward_capacity\(p_studio uuid, p_livemode boolean, p_assume_live boolean default false\)/);
    // the position's card term and its price-reduction term both go through it
    expect((c.match(/public\.card_counts_toward_capacity\(p_studio, /g) ?? []).length).toBeGreaterThanOrEqual(2);
    // no 0394 command takes a livemode argument: an owner could otherwise claim any mode
    // the money commands (cash, transfer, refund, position, refusal) do not take a mode: only ensure_visit_bill's existing p_livemode (bill creation over live card money) and the helper do
    for (const fn of ["record_visit_external_payment", "request_payment_refund", "visit_payment_position", "visit_payment_refusal"]) {
      const sig = c.slice(c.indexOf(`function public.${fn}(`), c.indexOf(")", c.indexOf(`function public.${fn}(`)));
      expect(sig, fn).not.toMatch(/livemode/);
    }
    // p_assume_live is passed true ONLY by the card wall, from the row being inserted; no command passes it
    expect(c).toContain("new.amount_cents, new.stripe_livemode is true)");
    expect((c.match(/p_assume_live/g) ?? []).length).toBeGreaterThan(0);
    expect(c).not.toMatch(/visit_payment_refusal\(p_studio_id, p_appointment_id, p_amount_cents, true/);
    for (const fn of ["studio_has_gone_live(uuid)", "card_counts_toward_capacity(uuid, boolean, boolean)"]) {
      expect(c).toContain(`revoke all privileges on function public.${fn} from public, anon, authenticated, service_role;`);
      expect(DOWN).toContain(`drop function public.${fn};`);
    }
  });

  it("down refuses (55000) while split money exists", () => {
    expect(DOWN).toMatch(/errcode = '55000'/);
    expect(DOWN).toContain("from public.visit_bills");
  });
});
