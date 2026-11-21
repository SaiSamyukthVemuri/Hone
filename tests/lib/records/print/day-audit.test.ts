import { describe, expect, it } from "vitest";
import {
  auditThenLoad,
  canPrintClinicalPacket,
  previewAuditMetadata,
  printAuditMetadata,
  recordDayAudit,
  type AuditRpc,
} from "@/lib/records/print/day-audit";
import { readFileSync } from "node:fs";

const ID = "0b9f3c64-1111-4222-8333-444455556666";
const rpcReturning = (data: unknown, error: unknown = null): { rpc: AuditRpc; calls: Array<Record<string, unknown>> } => {
  const calls: Array<Record<string, unknown>> = [];
  return { calls, rpc: (_fn, args) => { calls.push(args); return Promise.resolve({ data, error }); } };
};

describe("audit metadata matches the 0233 allow-list for scope day, exactly", () => {
  const sql = readFileSync("supabase/migrations/0233_clinical_records_audit_command.sql", "utf8");
  it("preview is {scope, day} and print adds only preview_audit_id", () => {
    expect(previewAuditMetadata("2026-05-10")).toEqual({ scope: "day", day: "2026-05-10" });
    expect(printAuditMetadata("2026-05-10", ID)).toEqual({ scope: "day", day: "2026-05-10", preview_audit_id: ID });
  });
  it("0233 names every key we send and rejects the day scope carrying anything else", () => {
    for (const k of ["scope", "day", "preview_audit_id"]) expect(sql).toContain(k);
    expect(sql).toContain("scope day requires day and nothing else");
    expect(sql).toContain("clinical_records_previewed");
    expect(sql).toContain("clinical_records_printed");
  });
});

describe("recordDayAudit (fail closed)", () => {
  it("sends the client and metadata only, never an actor or studio, and returns the new id", async () => {
    const { rpc, calls } = rpcReturning(ID.toUpperCase());
    const r = await recordDayAudit(rpc, { clientId: "c1", action: "clinical_records_previewed", metadata: previewAuditMetadata("2026-05-10") });
    expect(r).toEqual({ ok: true, auditId: ID });
    expect(Object.keys(calls[0]).sort()).toEqual(["p_action", "p_client_id", "p_id", "p_metadata"]);
  });
  it("any error, malformed response or thrown transport error is a refusal", async () => {
    const meta = previewAuditMetadata("2026-05-10");
    const a = { clientId: "c1", action: "clinical_records_previewed" as const, metadata: meta };
    expect(await recordDayAudit(rpcReturning(ID, { code: "22023" }).rpc, a)).toEqual({ ok: false });
    expect(await recordDayAudit(rpcReturning(null).rpc, a)).toEqual({ ok: false });
    expect(await recordDayAudit(rpcReturning("not-a-uuid").rpc, a)).toEqual({ ok: false });
    expect(await recordDayAudit(() => { throw new Error("row data"); }, a)).toEqual({ ok: false });
    expect(await recordDayAudit(() => Promise.reject(new Error("row data")), a)).toEqual({ ok: false });
  });
});

describe("auditThenLoad: NEGATIVE CONTROL for 'audit before any read'", () => {
  it("a failed audit means the loader is never called", async () => {
    let loads = 0;
    const r = await auditThenLoad(() => Promise.resolve({ ok: false }), () => { loads += 1; return Promise.resolve({ ok: true, value: 1 }); });
    expect(r).toEqual({ ok: false, reason: "audit_failed" });
    expect(loads).toBe(0);
  });
  it("a throwing audit also blocks the load", async () => {
    let loads = 0;
    const r = await auditThenLoad(() => Promise.reject(new Error("x")), () => { loads += 1; return Promise.resolve({ ok: true, value: 1 }); });
    expect(r.ok).toBe(false);
    expect(loads).toBe(0);
  });
  it("the audit happens before the load, and the preview id comes back for the Print step", async () => {
    const order: string[] = [];
    const r = await auditThenLoad(
      () => { order.push("audit"); return Promise.resolve({ ok: true as const, auditId: ID }); },
      () => { order.push("load"); return Promise.resolve({ ok: true as const, value: "doc" }); },
    );
    expect(order).toEqual(["audit", "load"]);
    expect(r).toEqual({ ok: true, document: "doc", previewAuditId: ID });
  });
  it("a failed load after a recorded audit is load_failed, never a partial document", async () => {
    expect(await auditThenLoad(() => Promise.resolve({ ok: true as const, auditId: ID }), () => Promise.resolve({ ok: false }))).toEqual({ ok: false, reason: "load_failed" });
  });
});

describe("canPrintClinicalPacket: NEGATIVE CONTROL for the owner gate", () => {
  it("only an active owner passes", () => {
    expect(canPrintClinicalPacket({ role: "owner", active: true })).toBe(true);
    for (const role of ["practitioner", "receptionist", "admin", ""]) expect(canPrintClinicalPacket({ role, active: true })).toBe(false);
    expect(canPrintClinicalPacket({ role: "owner", active: false })).toBe(false);
  });
});
