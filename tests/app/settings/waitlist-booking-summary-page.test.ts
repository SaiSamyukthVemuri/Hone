import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The summary is owner-only, read-only and counts only. Page-level pins on where it is read and what it may call.
const root = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const PAGE = read("app/(app)/settings/waitlist/page.tsx");
const READ = read("lib/waitlist/invitation-booking-summary-read.ts");
const VIEW = read("lib/waitlist/invitation-booking-summary.ts");
const UI = read("components/waitlist/invitation-booking-summary.tsx");
const code = (s: string) => s.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

describe("the page reads the summary only after the owner check", () => {
  it("the summary reads come after the page's owner gate and nothing before it", () => {
    const gate = PAGE.indexOf('practitioner.role !== "owner"');
    const reads = PAGE.indexOf("loadCommandCounts(supabase");
    expect(gate).toBeGreaterThan(-1);
    expect(reads).toBeGreaterThan(gate);
    expect(PAGE.match(/loadCommandCounts\(/g)).toHaveLength(1);
    expect(PAGE.match(/loadOutcomeCounts\(/g)).toHaveLength(1);
  });
  it("renders it once, with the studio's own time zone", () => {
    expect(PAGE.match(/<InvitationBookingSummary /g)).toHaveLength(1);
    expect(PAGE).toMatch(/<InvitationBookingSummary summary=\{bookingSummary\} timeZone=\{studio\.timezone\} \/>/);
  });
});

describe("it only reads, with the owner's own session", () => {
  it("calls only the one command, and reads one table with head-only counts", () => {
    const r = code(READ);
    expect([...r.matchAll(/\.rpc\(\s*([A-Z_]+|"[a-z_]+")/g)].map((m) => m[1])).toEqual(["COMMAND"]);
    expect(r).toContain('const COMMAND = "waitlist_invitation_booking_counts"');
    expect(r).toContain('const TABLE = "new_client_waitlist_invitations"');
    expect(r).toContain('{ count: "exact", head: true }');
    expect(r).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    expect(r).not.toMatch(/createAdminClient|service_role|SERVICE_ROLE/);
  });
  it("selects only an id, never a name, a contact detail or a token", () => {
    const r = code(READ);
    expect([...r.matchAll(/\.select\(\s*"([^"]*)"/g)].map((m) => m[1])).toEqual(["id"]);
    expect(r).not.toMatch(/token|email|phone|name/i);
  });
  it("the pure module and the component do no I/O, send nothing and track nothing", () => {
    for (const s of [code(VIEW), code(UI)]) {
      expect(s).not.toMatch(/\bfetch\(|supabase|createClient|sendEmail|sendSms|analytics\.track|navigator\.sendBeacon|useEffect|"use client"/);
    }
  });
});
