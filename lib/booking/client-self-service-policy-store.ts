import "server-only";

import { dbErrorCode } from "@/lib/logging/error-class";
import {
  clientSelfServicePolicyFromStudio,
  type ClientSelfServicePolicy,
} from "@/lib/booking/client-self-service-policy";

// HON-47. Server-side read of a studio's client self-service policy.
//
// `select("*")` ON PURPOSE. Naming the flag columns would make every read fail
// with 42703 on a database where 0234 or the HON-47 migration has not applied,
// and turning that error into "allowed" would mean tolerating an error. With
// `*` the absent columns are simply absent keys, which the pure reader maps to
// today's behaviour, and every real error stays an error.
//
// FAIL CLOSED. An unreadable policy is reported as `ok: false`; each caller
// refuses with its generic message. A read failure must never be what opens a
// path the owner turned off.

type PolicyReader = {
  from(table: "studios"): {
    select(columns: "*"): {
      eq(
        column: "id",
        value: string,
      ): {
        maybeSingle(): PromiseLike<{
          data: Record<string, unknown> | null;
          error: { code?: string | null } | null;
        }>;
      };
    };
  };
};

export type LoadClientSelfServicePolicyResult =
  | { ok: true; policy: ClientSelfServicePolicy; studioName: string | null }
  | { ok: false };

export async function loadClientSelfServicePolicy(
  admin: unknown,
  studioId: string | null | undefined,
): Promise<LoadClientSelfServicePolicyResult> {
  if (!studioId) return { ok: false };
  const { data, error } = await (admin as PolicyReader)
    .from("studios")
    .select("*")
    .eq("id", studioId)
    .maybeSingle();
  if (error || !data) {
    console.error(
      JSON.stringify({
        event: "client_self_service_policy_read_failed",
        code: error ? dbErrorCode(error) : "not_found",
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false };
  }
  return {
    ok: true,
    policy: clientSelfServicePolicyFromStudio(data),
    studioName: typeof data.name === "string" ? data.name : null,
  };
}
