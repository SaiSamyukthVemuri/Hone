import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  OWNER_READABLE_REGISTRATION_COLUMNS,
  REGISTRATION_KINDS,
  REGISTRATION_STATUSES,
  registrationEvidenceFor,
  registrationKindFor,
  type RegistrationRead,
  type SenderRegistrationRow,
} from "@/lib/sms/sender-registration";
import { destinationReadiness } from "@/lib/sms/sender-readiness";
import type { SenderRead } from "@/lib/sms/sender-status";

// SMS-SENDER-REG-01: recorded registration evidence (0217) as the readiness
// model receives it, and the vocabulary pinned to the migration.

const SQL = readFileSync(
  path.join(process.cwd(), "supabase/migrations/0217_studio_sms_sender_registrations.sql"),
  "utf8",
);

const row = (kind: SenderRegistrationRow["kind"], status: SenderRegistrationRow["status"], missing: string | null = null): SenderRegistrationRow => ({
  id: "r", studio_id: "s", sender_id: "x", kind, status, missing_information: missing,
  recorded_at: "2026-10-12T00:00:00Z", updated_at: "2026-10-12T00:00:00Z",
});
const read = (...rows: SenderRegistrationRow[]): RegistrationRead => ({ ok: true, rows });

const US = "+12125550123";
const TF = "+18885550123";
const CA = "+16045550123";

describe("the number decides which registration matters", () => {
  it("any long code (US or Canadian) -> 10DLC; toll-free -> verification; other or invalid -> none", () => {
    expect(registrationKindFor(US)).toBe("us_10dlc");
    expect(registrationKindFor(CA)).toBe("us_10dlc");
    expect(registrationKindFor(TF)).toBe("toll_free_verification");
    expect(registrationKindFor("+18765550123")).toBeNull();
    expect(registrationKindFor(null)).toBeNull();
  });

  it("a REGISTERED Canadian long code serves US recipients, end to end", () => {
    const sender: SenderRead = {
      ok: true,
      sender: {
        id: "x", studio_id: "s", provider: "twilio", status: "active", country: "CA", requested_area_code: null,
        phone_number: CA, provisioned_at: null, last_test_ok_at: null, last_error_code: null, last_error_at: null,
        released_at: null, created_at: "", updated_at: "",
      },
    };
    const evidence = registrationEvidenceFor(read(row("us_10dlc", "approved")), CA);
    expect(destinationReadiness("US", sender, evidence).state).toBe("active");
    expect(destinationReadiness("CA", sender, { state: "not_recorded" }).state).toBe("active");
  });

  it("a row of the OTHER kind says nothing about this number", () => {
    expect(registrationEvidenceFor(read(row("toll_free_verification", "approved")), US)).toEqual({ state: "not_recorded" });
    expect(registrationEvidenceFor(read(row("us_10dlc", "approved")), TF)).toEqual({ state: "not_recorded" });
  });

  it("each recorded status maps to its evidence, with what is missing", () => {
    for (const status of ["pending", "approved", "rejected", "suspended"] as const) {
      expect(registrationEvidenceFor(read(row("us_10dlc", status)), US)).toEqual({ state: status });
    }
    expect(registrationEvidenceFor(read(row("us_10dlc", "requires_information", "a sample message")), US)).toEqual({
      state: "requires_information",
      missing: "a sample message",
    });
  });

  it("a failed read is UNREADABLE, never 'not recorded', and readiness says Unavailable", () => {
    expect(registrationEvidenceFor({ ok: false }, US)).toEqual({ state: "unreadable" });
    const sender: SenderRead = {
      ok: true,
      sender: {
        id: "x", studio_id: "s", provider: "twilio", status: "active", country: "US", requested_area_code: null,
        phone_number: US, provisioned_at: null, last_test_ok_at: null, last_error_code: null, last_error_at: null,
        released_at: null, created_at: "", updated_at: "",
      },
    };
    expect(destinationReadiness("US", sender, { state: "unreadable" }).state).toBe("unavailable");
    expect(destinationReadiness("US", sender, registrationEvidenceFor(read(row("us_10dlc", "approved")), US)).state).toBe("active");
  });
});

describe("the vocabulary is 0217's", () => {
  it("kinds and statuses", () => {
    for (const k of REGISTRATION_KINDS) expect(SQL).toContain(`'${k}'`);
    for (const s of REGISTRATION_STATUSES) expect(SQL).toContain(`'${s}'`);
    expect(SQL).toMatch(/check \(kind in \('us_10dlc', 'toll_free_verification'\)\)/);
    expect(SQL).toMatch(/check \(status in \('pending', 'requires_information', 'approved', 'rejected', 'suspended'\)\)/);
  });

  it("the owner columns are exactly the grant, and the provider reference is not among them", () => {
    const grant = SQL.match(/grant select \(([^)]*)\)\s+on public\.studio_sms_sender_registrations to authenticated;/);
    expect(grant).not.toBeNull();
    const granted = grant![1].split(",").map((c) => c.trim());
    expect(granted).toEqual([...OWNER_READABLE_REGISTRATION_COLUMNS]);
    expect(granted).not.toContain("provider_reference");
  });
});
