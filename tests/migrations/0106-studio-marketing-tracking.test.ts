import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILE = "0106_studio_marketing_tracking.sql";
const SQL = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");

describe("0106 studio marketing tracking — number", () => {
  it("is the repo migration max (global tripwire lives in the newest migration's test)", () => {
    const maxNum = Math.max(
      ...readdirSync(MIGRATIONS_DIR)
        .map((f) => /^(\d{4})_/.exec(f)?.[1])
        .filter(Boolean)
        .map((n) => Number(n)),
    );
    expect(maxNum).toBe(106);
    expect(FILE).toMatch(/^0106_/);
  });
});

describe("0106 studio marketing tracking — tables", () => {
  it("creates all three tables", () => {
    expect(SQL).toMatch(/create table if not exists public\.studio_tracking_providers/);
    expect(SQL).toMatch(/create table if not exists public\.conversion_event_deliveries/);
    expect(SQL).toMatch(/create table if not exists public\.booking_tracking_consents/);
  });

  it("studio_tracking_providers has enabled default false + secret REF (no token value)", () => {
    expect(SQL).toMatch(/enabled\s+boolean not null default false/);
    expect(SQL).toMatch(/server_token_secret_ref\s+text/);
    expect(SQL).toMatch(/consent_mode\s+text not null default 'explicit'/);
  });

  it("provider check supports all 8 providers", () => {
    for (const p of ["meta", "google_ads", "ga4", "tiktok", "pinterest", "linkedin", "microsoft_ads", "custom"]) {
      expect(SQL).toContain(`'${p}'`);
    }
  });

  it("status check supports skipped/sent/failed/claimed", () => {
    expect(SQL).toMatch(/status in \('skipped', 'sent', 'failed', 'claimed'\)/);
  });

  it("consent_source check supports the four sources", () => {
    for (const s of ["public_booking", "portal", "studio_website", "admin_import"]) {
      expect(SQL).toContain(`'${s}'`);
    }
  });
});

describe("0106 — uniqueness + indexes + trigger", () => {
  it("unique(studio_id, provider) on providers", () => {
    expect(SQL).toMatch(/unique \(studio_id, provider\)/);
  });
  it("unique(studio_id, provider, event_id) dedup on deliveries", () => {
    expect(SQL).toMatch(/unique \(studio_id, provider, event_id\)/);
  });
  it("has studio/provider/event lookup indexes", () => {
    expect(SQL).toMatch(/create index if not exists studio_tracking_providers_studio_enabled_idx/);
    expect(SQL).toMatch(/create index if not exists conversion_event_deliveries_studio_provider_idx/);
    expect(SQL).toMatch(/create index if not exists booking_tracking_consents_studio_client_idx/);
  });
  it("updated_at trigger on providers", () => {
    expect(SQL).toMatch(/create trigger tg_studio_tracking_providers_set_updated_at/);
  });
});

describe("0106 — RLS + studio isolation on every table", () => {
  it("enables RLS on all three tables", () => {
    const enables = SQL.match(/enable row level security/g) ?? [];
    expect(enables.length).toBe(3);
  });
  it("every SELECT policy scopes by is_studio_member(studio_id)", () => {
    const scoped = SQL.match(/using \(public\.is_studio_member\(studio_id\)\)/g) ?? [];
    // 3 selects + 1 update using-clause = 4
    expect(scoped.length).toBeGreaterThanOrEqual(4);
  });
  it("providers allow member insert/update; deliveries + consents are SELECT-only for members", () => {
    expect(SQL).toMatch(/studio_tracking_providers_studio_member_insert/);
    expect(SQL).toMatch(/studio_tracking_providers_studio_member_update/);
    expect(SQL).not.toMatch(/conversion_event_deliveries_studio_member_insert/);
    expect(SQL).not.toMatch(/booking_tracking_consents_studio_member_insert/);
  });
});

describe("0106 — claim RPC (dedup) is service_role only", () => {
  it("defines claim_conversion_delivery as security definer with fixed search_path", () => {
    expect(SQL).toMatch(/create or replace function public\.claim_conversion_delivery/);
    expect(SQL).toMatch(/security definer/);
    expect(SQL).toMatch(/set search_path = public/);
    expect(SQL).toMatch(/on conflict \(studio_id, provider, event_id\) do nothing/);
  });
  it("revokes public/anon/authenticated execute and grants only service_role", () => {
    expect(SQL).toMatch(/revoke all on function public\.claim_conversion_delivery[\s\S]*from public, anon, authenticated/);
    expect(SQL).toMatch(/grant execute on function public\.claim_conversion_delivery[\s\S]*to service_role/);
  });
});

describe("0106 — data minimization: NO clinical / PII / token-value columns", () => {
  const forbidden = [
    "email", "phone", "notes", "intake", "contraindication", "allergie",
    "fitzpatrick", "skin_", "body_area", " area ", "photo", "cancellation_reason",
    "diagnosis", "medication", "health",
    // raw token value columns (only *_secret_ref is allowed)
    "access_token", "api_token", "token_value", "secret_value", "auth_token",
  ];
  for (const f of forbidden) {
    it(`no column named like "${f.trim()}"`, () => {
      // strip comments so the negative-contract comment block doesn't trip us
      const codeOnly = SQL.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
      expect(codeOnly.toLowerCase()).not.toContain(f.toLowerCase());
    });
  }
  it("only a secret REFERENCE column exists (server_token_secret_ref)", () => {
    expect(SQL).toContain("server_token_secret_ref");
  });
});

describe("0106 — conversion service remains unwired/inert", () => {
  function read(rel: string): string {
    return readFileSync(path.resolve(__dirname, "../../", rel), "utf8");
  }
  it("meta adapter send() is still a not-wired skip; service does no network", () => {
    expect(read("lib/conversion/adapters/meta.ts")).toContain('errorSafe: "sender_not_wired"');
    expect(read("lib/conversion/service.ts")).not.toContain("fetch(");
  });
});
