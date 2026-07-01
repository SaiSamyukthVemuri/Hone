import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  computeIntakeLinkStatus,
  INTAKE_LINK_CLOSE_TO_EXPIRY_DAYS,
} from "@/lib/intake/link-status";

// PR #303 — smart intake resend status / expiry visibility. Migration 0097
// adds display metadata (last_sent_at, expires_at, send_count) stamped at each
// link mint; the UI shows an accurate expiry/days-left status. Read-only over a
// signed-token expiry (never claims delivery); no RLS/enum/token-format change.

const root = path.resolve(__dirname, "../../../");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l) && !/^\s*--/.test(l))
    .join("\n");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-07-01T12:00:00.000Z");
const base = {
  started_at: "2026-06-01T12:00:00.000Z",
  intake_link_last_sent_at: null as string | null,
  intake_link_expires_at: null as string | null,
  intake_link_send_count: 0 as number | null,
};

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------
describe("migration 0097 adds safe intake-link metadata columns", () => {
  const MIG = read("supabase/migrations/0097_intake_link_metadata.sql");
  it("adds the three columns, nullable / default-safe, non-destructive", () => {
    expect(MIG).toMatch(/add column if not exists intake_link_last_sent_at timestamptz/);
    expect(MIG).toMatch(/add column if not exists intake_link_expires_at timestamptz/);
    expect(MIG).toMatch(/add column if not exists intake_link_send_count integer not null default 0/);
  });
  it("makes no RLS / status-enum / token / destructive change", () => {
    // Strip SQL (--) comments so the explanatory header (which names what we
    // avoid) doesn't trip these negative greps on the actual statements.
    const sql = codeOnly(MIG);
    expect(sql).not.toMatch(/create policy|alter policy|drop policy/i);
    expect(sql).not.toMatch(/status_check|enum/i);
    expect(sql).not.toMatch(/drop column|drop table|token/i);
  });
});

// ---------------------------------------------------------------------------
// Pure status logic
// ---------------------------------------------------------------------------
describe("computeIntakeLinkStatus", () => {
  it("healthy: many days left → Resend intake link (count < 2)", () => {
    const s = computeIntakeLinkStatus(
      { ...base, intake_link_expires_at: new Date(NOW + 10 * DAY).toISOString(), intake_link_send_count: 1 },
      NOW,
    );
    expect(s.state).toBe("healthy");
    expect(s.daysLeft).toBe(10);
    expect(s.usingFallback).toBe(false);
    expect(s.buttonLabel).toBe("Resend intake link");
  });

  it("healthy but resent (send_count >= 2) → Resend again", () => {
    const s = computeIntakeLinkStatus(
      { ...base, intake_link_expires_at: new Date(NOW + 8 * DAY).toISOString(), intake_link_send_count: 3 },
      NOW,
    );
    expect(s.state).toBe("healthy");
    expect(s.buttonLabel).toBe("Resend again");
  });

  it("close to expiry (<= threshold days) → Send fresh link", () => {
    const s = computeIntakeLinkStatus(
      { ...base, intake_link_expires_at: new Date(NOW + INTAKE_LINK_CLOSE_TO_EXPIRY_DAYS * DAY).toISOString() },
      NOW,
    );
    expect(s.state).toBe("closeToExpiry");
    expect(s.buttonLabel).toBe("Send fresh link");
  });

  it("expired → Send fresh link, negative daysLeft", () => {
    const s = computeIntakeLinkStatus(
      { ...base, intake_link_expires_at: new Date(NOW - 2 * DAY).toISOString() },
      NOW,
    );
    expect(s.state).toBe("expired");
    expect(s.daysLeft).toBeLessThan(0);
    expect(s.buttonLabel).toBe("Send fresh link");
  });

  it("legacy null metadata → usingFallback from started_at + TTL", () => {
    // started_at 30 days ago, TTL 14 → already past → expired via fallback.
    const s = computeIntakeLinkStatus(base, NOW);
    expect(s.usingFallback).toBe(true);
    expect(s.state).toBe("expired");
    expect(s.lastSentAt).toBeNull();
    expect(s.sendCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Stamping helper + mint-path wiring (source pins)
// ---------------------------------------------------------------------------
describe("stamping helper + every mint path stamps metadata", () => {
  const QUERIES = read("lib/intake/queries.ts");
  const ACTIONS = read("app/(app)/clients/[id]/intake/actions.ts");

  it("stampIntakeLinkIssued refreshes expiry + increments count; sets last_sent_at only when emailed", () => {
    expect(QUERIES).toMatch(/export async function stampIntakeLinkIssued/);
    expect(QUERIES).toMatch(/intake_link_expires_at: expiresAt/);
    expect(QUERIES).toMatch(/intake_link_send_count: nextCount/);
    expect(QUERIES).toMatch(/if \(opts\.emailed\)/);
    expect(QUERIES).toMatch(/patch\.intake_link_last_sent_at/);
    // Uses the admin client (no RLS change) and never touches `responses`.
    expect(QUERIES).not.toMatch(/stampIntakeLinkIssued[\s\S]{0,600}responses/);
  });

  it("booking/reschedule (ensureIntakeForClient) stamps emailed", () => {
    expect(QUERIES).toMatch(/stampIntakeLinkIssued\(admin, intakeId, \{ emailed: true \}\)/);
  });

  it("resend email stamps emailed=true; copy link stamps emailed=false", () => {
    expect(ACTIONS).toMatch(/stampIntakeLinkIssued\(createAdminClient\(\), intake\.id, \{\s*emailed: true,?\s*\}\)/);
    expect(ACTIONS).toMatch(/stampIntakeLinkIssued\(createAdminClient\(\), intake\.id, \{\s*emailed: false,?\s*\}\)/);
  });

  it("request-update stamps emailed only when actually emailed", () => {
    expect(ACTIONS).toMatch(/stampIntakeLinkIssued\(createAdminClient\(\), created\.id, \{\s*emailed: emailSent,?\s*\}\)/);
  });

  it("no raw token stored + no token/PII logging in the stamp", () => {
    // The stamp only writes the three metadata columns — no token column.
    expect(QUERIES).not.toMatch(/intake_link_token|token:/);
    // Metadata error log carries no token/PII.
    expect(QUERIES).toMatch(/Failed to stamp intake link metadata/);
    expect(QUERIES).not.toMatch(/console\.[a-z]+\([^)]*token/i);
  });
});

// ---------------------------------------------------------------------------
// UI (source pins)
// ---------------------------------------------------------------------------
describe("smart status UI on the resend card", () => {
  const CARD = read("app/(app)/clients/[id]/intake/IntakeResendCard.tsx");
  const CARD_CODE = codeOnly(CARD);
  const OVERVIEW = read("app/(app)/clients/[id]/page.tsx");
  const PAGE = read("app/(app)/clients/[id]/intake/page.tsx");

  it("renders normal-state status lines", () => {
    expect(CARD).toMatch(/Intake link emailed/);
    expect(CARD).toMatch(/Current link expires/);
    expect(CARD).toMatch(/days left|day} left|day left/);
    expect(CARD).toMatch(/Client has not submitted yet\./);
  });

  it("renders close-to-expiry and expired copy with Send fresh link", () => {
    expect(CARD).toMatch(/This intake link expires soon\. Send a fresh link so the client can\s*continue\./);
    expect(CARD).toMatch(/This intake link has likely expired\. Send a fresh link\./);
  });

  it("keeps the legacy started_at fallback hedge", () => {
    expect(CARD).toMatch(/The previous link may have expired\./);
    expect(CARD).toMatch(/status\.usingFallback && linkMaybeExpired/);
  });

  it("uses the computed dynamic button label", () => {
    expect(CARD).toMatch(/status\.buttonLabel/);
  });

  it("does not overclaim delivery/receipt/opened/completed", () => {
    expect(CARD_CODE).not.toMatch(/\b(delivered|received|opened by|has opened)\b/i);
  });

  it("both surfaces compute + pass the status", () => {
    expect(PAGE).toMatch(/status=\{computeIntakeLinkStatus\(intake, Date\.now\(\)\)\}/);
    expect(OVERVIEW).toMatch(/status=\{computeIntakeLinkStatus\(intake, Date\.now\(\)\)\}/);
    // Legacy linkMaybeExpired prop is still computed (unchanged behavior).
    expect(PAGE).toMatch(/linkMaybeExpired=/);
    expect(OVERVIEW).toMatch(/linkMaybeExpired=/);
  });
});
