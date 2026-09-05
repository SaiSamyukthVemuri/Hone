import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ClaimResult,
  ClaimRow,
  FailResult,
  FinalizeResult,
  ProvisioningStore,
} from "./provisioning";

// The Supabase-backed ProvisioningStore (COMMS-01B).
//
// Thin by design. Every decision -- who may claim, whether a second request
// gets a second claim, whether a row may reach `active` -- belongs to migration
// 0191's commands, which run as SECURITY DEFINER and are granted to
// service_role alone. This file translates and validates; it never decides.
//
// FAIL-CLOSED. An RPC error, or a result word this file does not recognise,
// becomes a refusal rather than an optimistic assumption. The one thing that
// must never happen is treating an unrecognised response as "no claim exists",
// which is how a caller would talk itself into a second purchase.

const CLAIM_RESULTS: readonly ClaimResult[] = [
  "claimed",
  "claim_held",
  "already_active",
  "not_claimable",
  "not_a_member",
  "not_owner",
  "studio_not_found",
  "invalid_input",
];

const FINALIZE_RESULTS: readonly FinalizeResult[] = [
  "activated",
  "provisioned_untested",
  "already_active",
  "conflict",
  "lease_lost",
  "claim_not_found",
  "not_provisioning",
  "invalid_input",
];

const FAIL_RESULTS: readonly FailResult[] = [
  "failed",
  "lease_lost",
  "already_active",
  "not_provisioning",
  "claim_not_found",
  "invalid_input",
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * `claim_studio_sms_provisioning` RETURNS TABLE, so PostgREST hands back an
 * array of one row.
 */
function firstRow(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) return data.length > 0 ? asRecord(data[0]) : null;
  return asRecord(data);
}

export function createProvisioningStore(
  admin: SupabaseClient,
): ProvisioningStore {
  return {
    async claim(input): Promise<ClaimRow> {
      const { data, error } = await admin.rpc("claim_studio_sms_provisioning", {
        p_studio_id: input.studioId,
        p_actor_user_id: input.actorUserId,
        p_country: input.country,
        p_requested_area_code: input.areaCode,
      });

      const refused: ClaimRow = {
        result: "invalid_input",
        senderId: null,
        claimKey: null,
        senderStatus: null,
        leaseGeneration: null,
      };
      // A failed claim RPC means NO claim was taken, so nothing billable may
      // follow. The error is not logged here: it can carry SQL text, and the
      // orchestration above has the safe taxonomy for what to record.
      if (error) return refused;

      const row = firstRow(data);
      if (!row) return refused;

      const result = row.result;
      if (
        typeof result !== "string" ||
        !(CLAIM_RESULTS as readonly string[]).includes(result)
      ) {
        return refused;
      }

      return {
        result: result as ClaimResult,
        senderId: asNullableString(row.sender_id),
        claimKey: asNullableString(row.claim_key),
        senderStatus: asNullableString(row.sender_status),
        leaseGeneration:
          typeof row.lease_generation === "number" ? row.lease_generation : null,
      };
    },

    async finalize(input): Promise<FinalizeResult> {
      const { data, error } = await admin.rpc(
        "finalize_studio_sms_provisioning",
        {
          p_studio_id: input.studioId,
          p_claim_key: input.claimKey,
          p_lease_generation: input.leaseGeneration,
          p_phone_number: input.phoneNumber,
          p_phone_number_sid: input.phoneNumberSid,
          p_messaging_service_sid: input.messagingServiceSid,
          p_test_ok: input.testOk,
        },
      );
      if (error) return "invalid_input";
      if (
        typeof data !== "string" ||
        !(FINALIZE_RESULTS as readonly string[]).includes(data)
      ) {
        return "invalid_input";
      }
      return data as FinalizeResult;
    },

    async fail(input): Promise<FailResult> {
      const { data, error } = await admin.rpc("fail_studio_sms_provisioning", {
        p_studio_id: input.studioId,
        p_claim_key: input.claimKey,
        p_lease_generation: input.leaseGeneration,
        p_error_code: input.errorCode,
      });
      if (error) return "invalid_input";
      if (
        typeof data !== "string" ||
        !(FAIL_RESULTS as readonly string[]).includes(data)
      ) {
        return "invalid_input";
      }
      return data as FailResult;
    },

    async assertLease(input): Promise<boolean> {
      const { data, error } = await admin.rpc("assert_studio_sms_lease", {
        p_studio_id: input.studioId,
        p_claim_key: input.claimKey,
        p_lease_generation: input.leaseGeneration,
      });
      // FAIL CLOSED, and this is the one place it matters most: an error or an
      // unrecognised answer must read as "you do not hold this lease", never as
      // "carry on and buy a phone number". Only an explicit true spends money.
      if (error) return false;
      return data === true;
    },
  };
}
