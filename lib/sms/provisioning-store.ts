import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ClaimResult,
  ClaimRow,
  FailResult,
  FinalizeResult,
  OwnerAuthority,
  OwnerAuthorityReader,
  ProviderResourceBinding,
  SenderBindingReader,
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

export const CLAIM_RESULTS: readonly ClaimResult[] = [
  "claimed",
  "claim_held",
  "already_active",
  "number_mismatch",
  "not_claimable",
  "not_a_member",
  "not_owner",
  "studio_not_found",
  "invalid_input",
];

export const FINALIZE_RESULTS: readonly FinalizeResult[] = [
  "activated",
  "provisioned_untested",
  "already_active",
  "conflict",
  "lease_lost",
  "claim_not_found",
  "not_provisioning",
  "invalid_input",
];

export const FAIL_RESULTS: readonly FailResult[] = [
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

/**
 * Returns BOTH ports from one object: the full store, and the read-only
 * authority reader the inspect path needs. Callers hand each consumer only the
 * narrower handle it should have.
 */
export function createProvisioningStore(
  admin: SupabaseClient,
): ProvisioningStore & OwnerAuthorityReader & SenderBindingReader {
  return {
    /**
     * READ-ONLY, and deliberately a direct table read rather than an RPC:
     * 0191 exposes no read-only authority function, and adding one would be a
     * migration this correction does not need. The predicates mirror
     * claim_studio_sms_provisioning exactly -- studio_id, user_id, active --
     * so the two cannot answer differently for the same actor.
     *
     * FAILS CLOSED. A transport error or an unreadable row is `unavailable`,
     * never `not_owner`: "we could not check" and "we checked and the answer is
     * no" are different facts, and only one of them is safe to retry.
     */
    async readOwnerAuthority(input): Promise<OwnerAuthority> {
      const studio = await admin
        .from("studios")
        .select("id")
        .eq("id", input.studioId)
        .maybeSingle();
      if (studio.error) return "unavailable";
      if (!studio.data) return "studio_not_found";

      const { data, error } = await admin
        .from("practitioners")
        .select("role")
        .eq("studio_id", input.studioId)
        .eq("user_id", input.actorUserId)
        .eq("active", true)
        .maybeSingle();
      if (error) return "unavailable";
      if (!data) return "not_a_member";
      return data.role === "owner" ? "owner" : "not_owner";
    },

    /**
     * READ-ONLY tenancy authority for provider resources.
     *
     * The Messaging Service half uses 0191's own resolver, which is the
     * attribution key that migration already established -- the same function
     * that turns an inbound callback into exactly one studio.
     *
     * THE PHONE-NUMBER HALF HAS NO AUTHORITY YET, and it FAILS CLOSED rather
     * than being reported as unbound. 0191 revokes every table privilege on
     * `studio_sms_senders` from `service_role` by name, so there is no direct
     * read, and it exposes no resolver keyed by `phone_number_sid` -- only a
     * unique index. Answering `unbound` here would be a guess, and the guess
     * that is wrong is a cross-tenant write.
     *
     * The smallest thing that closes it is a numbered migration adding
     * `resolve_studio_by_sms_phone_number(text)` alongside the existing
     * resolver. That is deliberately NOT done here: this pass assigns no
     * migration number, and nothing is blocked today because this capability
     * has no product callers.
     */
    async readProviderResourceBindings(input): Promise<{
      phoneNumberSid: ProviderResourceBinding;
      messagingServiceSid: ProviderResourceBinding;
    }> {
      const service = await admin.rpc("resolve_studio_by_sms_messaging_service", {
        p_messaging_service_sid: input.messagingServiceSid,
      });

      const messagingServiceSid: ProviderResourceBinding = service.error
        ? { kind: "unavailable", reason: "resolver_failed" }
        : typeof service.data === "string" && service.data.length > 0
          ? { kind: "bound", studioId: service.data }
          : { kind: "unbound" };

      return {
        phoneNumberSid: {
          kind: "unavailable",
          reason: "no_phone_number_sid_resolver",
        },
        messagingServiceSid,
      };
    },

    async claim(input): Promise<ClaimRow> {
      const { data, error } = await admin.rpc("claim_studio_sms_provisioning", {
        p_studio_id: input.studioId,
        p_actor_user_id: input.actorUserId,
        p_country: input.country,
        p_requested_area_code: input.areaCode,
        p_phone_number: input.phoneNumber,
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

    async renewLease(input): Promise<boolean> {
      const { data, error } = await admin.rpc("renew_studio_sms_lease", {
        p_studio_id: input.studioId,
        p_claim_key: input.claimKey,
        p_lease_generation: input.leaseGeneration,
        p_phone_number: input.phoneNumber,
      });
      // FAIL CLOSED, and this is the one place it matters most: an error or an
      // unrecognised answer must read as "you do not hold this lease", never as
      // "carry on and buy a phone number". Only an explicit true spends money.
      if (error) return false;
      return data === true;
    },
  };
}
