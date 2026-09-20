import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  OWNER_READABLE_SENDER_COLUMNS,
  RECOVERY_ROUTE_BY_ERROR_CODE,
  SENDER_STATUSES,
  presentSenderStatus,
  type SenderStatus,
  type StudioSmsSenderState,
} from "@/lib/sms/sender-status";
import { PROVIDER_ERROR_CODES } from "@/lib/sms/provider/types";

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

function row(over: Partial<StudioSmsSenderState> = {}): StudioSmsSenderState {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    studio_id: "22222222-2222-2222-2222-222222222222",
    provider: "twilio",
    status: "off",
    country: "US",
    requested_area_code: null,
    phone_number: null,
    provisioned_at: null,
    last_test_ok_at: null,
    last_error_code: null,
    last_error_at: null,
    released_at: null,
    created_at: "2026-09-20T00:00:00Z",
    updated_at: "2026-09-20T00:00:00Z",
    ...over,
  };
}

describe("the status vocabulary matches migration 0191, not a restatement", () => {
  const migration = read(
    "supabase/migrations/0191_studio_sms_sender_provisioning.sql",
  );

  it("covers exactly the eight statuses the CHECK constraint allows", () => {
    // Parsed out of the migration so a ninth status added there fails HERE
    // rather than rendering as a blank card in production.
    const check = migration.match(
      /studio_sms_senders_status_check[\s\S]*?check \(status in \(([\s\S]*?)\)\)/,
    );
    expect(check, "status CHECK not found in 0191").not.toBeNull();
    const fromSql = [...check![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(fromSql.length).toBeGreaterThan(0); // anti-vacuity
    expect([...fromSql].sort()).toEqual([...SENDER_STATUSES].sort());
  });

  it("reads exactly the columns 0191 grants to `authenticated`", () => {
    // The guarantee is that this surface cannot reach a provider identifier.
    // Asserting it against the GRANT rather than against a copied list means a
    // widened grant has to be noticed here too.
    const grant = migration.match(
      /grant select \(([\s\S]*?)\) on public\.studio_sms_senders to authenticated;/,
    );
    expect(grant, "column grant not found in 0191").not.toBeNull();
    const granted = grant![1]
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    expect(granted.length).toBe(14); // anti-vacuity
    expect([...OWNER_READABLE_SENDER_COLUMNS].sort()).toEqual(
      [...granted].sort(),
    );
  });

  it("never names a provider identifier or the claim key", () => {
    for (const forbidden of [
      "messaging_service_sid",
      "phone_number_sid",
      "provisioning_claim_key",
      "provisioning_lease_generation",
      "claimed_phone_number",
    ]) {
      expect(
        OWNER_READABLE_SENDER_COLUMNS as readonly string[],
        `${forbidden} must not be readable by a browser session`,
      ).not.toContain(forbidden);
    }
  });
});

describe("every status presents, including the one production is actually in", () => {
  it("no row -> the honest empty state, which every studio is in today", () => {
    const view = presentSenderStatus(null);
    expect(view.status).toBeNull();
    expect(view.tone).toBe("none");
    expect(view.headline).toBe("No sender configured");
    // It must say what DOES happen, or an operator reads this as "my texts are
    // not going out" — which would be false.
    expect(view.detail).toMatch(/shared sender/i);
    expect(view.phoneNumber).toBeNull();
    expect(view.recovery).toBe("none");
  });

  for (const status of SENDER_STATUSES) {
    it(`${status} renders a headline and a sentence`, () => {
      const view = presentSenderStatus(row({ status }));
      expect(view.status).toBe(status);
      expect(view.headline.length).toBeGreaterThan(0);
      expect(view.detail.length).toBeGreaterThan(0);
    });
  }

  it("active reports the number and the passed test", () => {
    const view = presentSenderStatus(
      row({
        status: "active",
        phone_number: "+15555550123",
        provisioned_at: "2026-09-20T00:00:00Z",
        last_test_ok_at: "2026-09-20T00:00:00Z",
      }),
    );
    expect(view.tone).toBe("live");
    expect(view.phoneNumber).toBe("+15555550123");
    expect(view.lastTestOkAt).toBe("2026-09-20T00:00:00Z");
    expect(view.recovery).toBe("none");
  });

  it("released is history and offers nothing", () => {
    const view = presentSenderStatus(
      row({ status: "released", released_at: "2026-09-20T00:00:00Z" }),
    );
    expect(view.tone).toBe("retired");
    expect(view.recovery).toBe("none");
    expect(view.detail).toMatch(/never reused/i);
  });

  it("never offers a route 0191's transition guard forbids", () => {
    // `error` may retry or release; it may NEVER return to `off`. A surface
    // that offered "start over" would be asking for a transition the database
    // refuses — and the gesture abandons a possibly-purchased number.
    for (const status of SENDER_STATUSES) {
      const view = presentSenderStatus(row({ status }));
      expect(view.recovery).not.toBe("reset");
    }
    const errored = presentSenderStatus(
      row({
        status: "error",
        last_error_code: "provider_timeout",
        last_error_at: "2026-09-20T00:00:00Z",
      }),
    );
    expect(errored.recovery).toBe("retry");
    expect(errored.detail).not.toMatch(/start over|reset/i);
  });
});

describe("#677 stays load-bearing: provider_configuration_required is not a dead end", () => {
  // THE POINT OF THIS BLOCK. `adoption.ts` refuses with
  // `provider_configuration_required` when a real messaging service simply is
  // not wired the way Hone requires — which is what #677's configure path
  // repairs. But REFUSAL_TO_STORE_CODE collapses that refusal and five others
  // into ONE stored code, `provider_resource_mismatch`. The persisted state
  // therefore cannot distinguish "configurable" from "not yours at all".
  //
  // These assertions pin the consequence so the eventual adoption lane cannot
  // quietly ship a surface that dead-ends on it.
  const adoption = read("lib/sms/adoption.ts");

  it("the collapse this depends on is real, not assumed", () => {
    expect(adoption).toMatch(
      /provider_configuration_required:\s*"provider_resource_mismatch"/,
    );
    expect(adoption).toMatch(
      /number_not_owned_by_account:\s*"provider_resource_mismatch"/,
    );
  });

  it("the shared stored code routes to an operator decision, never to nothing", () => {
    // `none` would be the dead end. `retry` would be a lie in the
    // not-owned case. Neither is acceptable.
    expect(RECOVERY_ROUTE_BY_ERROR_CODE.provider_resource_mismatch).toBe(
      "operator_decision",
    );
    const view = presentSenderStatus(
      row({
        status: "error",
        last_error_code: "provider_resource_mismatch",
        last_error_at: "2026-09-20T00:00:00Z",
      }),
    );
    expect(view.recovery).toBe("operator_decision");
    expect(view.recovery).not.toBe("none");
    // And it must not claim to know which of the six refusals happened.
    expect(view.detail).not.toMatch(/webhook|not owned|does not own/i);
  });

  it("routes every provider error code the orchestration can store", () => {
    // A new code added to PROVIDER_ERROR_CODES without a route here would
    // otherwise fall to the `support` default silently.
    for (const code of PROVIDER_ERROR_CODES) {
      expect(
        RECOVERY_ROUTE_BY_ERROR_CODE[code],
        `${code} has no recovery route`,
      ).toBeDefined();
    }
  });

  it("an UNKNOWN code falls to support, never to retry", () => {
    const view = presentSenderStatus(
      row({
        status: "error",
        last_error_code: "something_new_from_a_later_slice",
        last_error_at: "2026-09-20T00:00:00Z",
      }),
    );
    expect(view.recovery).toBe("support");
  });
});

describe("the status type stays aligned with the DB status domain", () => {
  it("SenderStatus accepts only migration statuses", () => {
    // Compile-time in spirit, asserted at runtime so the list cannot drift
    // unnoticed if the type is widened.
    const statuses: SenderStatus[] = [...SENDER_STATUSES];
    expect(statuses).toHaveLength(8);
  });
});
