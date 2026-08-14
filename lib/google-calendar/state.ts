import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import {
  currentKeyVersion,
  decryptGoogleSecret,
  encryptGoogleSecret,
} from "./token-crypto";
import { generatePkce, randomUrlToken, sha256Hex } from "./oauth";
import { safeReturnPath } from "./config";
import type { CalendarDestinationMode } from "./destination-scopes";

// OAuth state + PKCE lifecycle (google_oauth_states). Service-role only.
//
// createOAuthState mints a single-use, 10-min, hash-stored `state` + a hash-
// stored session nonce (raw nonce goes into an httpOnly cookie by the caller),
// encrypts the PKCE verifier, and inserts the binding row.
//
// consumeOAuthState atomically consumes exactly one matching row and returns the
// verifier + the studio/practitioner binding: after validating expiry, nonce,
// and the calling user. It never returns anything on a replay/expiry/mismatch.

export type CreateStateResult =
  | { ok: true; state: string; nonce: string; codeChallenge: string }
  | { ok: false; reason: string };

export async function createOAuthState(input: {
  studioId: string;
  practitionerId: string;
  userId: string;
  redirectPath: string | null;
  // B2.4, destination-BOUND upgrade intent (migration 0131). Present only for a
  // destination scope-upgrade; a plain Phase-A connect passes null (binds neither
  // column). The DB CHECK enforces the matched pair. The mode + its EXACT
  // server-derived required scope are bound so the callback can reject a
  // destination/scope that changed between start and callback.
  destination?: { mode: CalendarDestinationMode; requiredScope: string } | null;
}): Promise<CreateStateResult> {
  const keyVersion = currentKeyVersion();
  if (keyVersion === null) return { ok: false, reason: "encryption_unavailable" };

  const state = randomUrlToken(32);
  const nonce = randomUrlToken(32);
  const pkce = generatePkce();

  const enc = encryptGoogleSecret(pkce.verifier);
  if (!enc.ok) return { ok: false, reason: enc.reason };

  const admin = createAdminClient();
  const { error } = await admin.from("google_oauth_states").insert({
    state_hash: sha256Hex(state),
    session_nonce_hash: sha256Hex(nonce),
    studio_id: input.studioId,
    practitioner_id: input.practitionerId,
    user_id: input.userId,
    encrypted_pkce_verifier: enc.ciphertext,
    encryption_key_version: enc.keyVersion,
    redirect_path: safeReturnPath(input.redirectPath),
    destination_mode: input.destination?.mode ?? null,
    required_event_scope: input.destination?.requiredScope ?? null,
  });
  if (error) return { ok: false, reason: "state_insert_failed" };

  return { ok: true, state, nonce, codeChallenge: pkce.challenge };
}

export type ConsumeStateResult =
  | {
      ok: true;
      studioId: string;
      practitionerId: string;
      userId: string;
      codeVerifier: string;
      redirectPath: string;
      // B2.4 destination binding (null for a plain Phase-A connect). The callback
      // uses these to reject a destination/scope that changed between start and
      // callback and to require the EXACT bound scope in the actual grant.
      destinationMode: CalendarDestinationMode | null;
      requiredEventScope: string | null;
    }
  | { ok: false; reason: string };

export async function consumeOAuthState(input: {
  state: string;
  nonce: string | null;
  userId: string;
}): Promise<ConsumeStateResult> {
  const admin = createAdminClient();
  const stateHash = sha256Hex(input.state);

  const { data: row, error } = await admin
    .from("google_oauth_states")
    .select(
      "id, session_nonce_hash, studio_id, practitioner_id, user_id, encrypted_pkce_verifier, redirect_path, expires_at, consumed_at, destination_mode, required_event_scope",
    )
    .eq("state_hash", stateHash)
    .maybeSingle();
  if (error || !row) return { ok: false, reason: "unknown_state" };

  if (row.consumed_at) return { ok: false, reason: "already_consumed" };
  if (new Date(row.expires_at as string).getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }
  // Double-submit binding: the httpOnly cookie nonce must hash to the stored
  // value. A missing/forged cookie fails here.
  if (!input.nonce || sha256Hex(input.nonce) !== row.session_nonce_hash) {
    return { ok: false, reason: "nonce_mismatch" };
  }
  // The returning session must be the SAME authenticated user that started it,
  // the structural guard against attaching a Google account to another user.
  if (input.userId !== row.user_id) return { ok: false, reason: "user_mismatch" };

  // Single-use compare-and-swap: only the first caller flips consumed_at.
  const { data: claimed, error: claimError } = await admin
    .from("google_oauth_states")
    .update({ consumed_at: new Date().toISOString() })
    .eq("id", row.id as string)
    .is("consumed_at", null)
    .select("id")
    .maybeSingle();
  if (claimError || !claimed) return { ok: false, reason: "consume_race" };

  const dec = decryptGoogleSecret(row.encrypted_pkce_verifier as string);
  if (!dec.ok) return { ok: false, reason: dec.reason };

  return {
    ok: true,
    studioId: row.studio_id as string,
    practitionerId: row.practitioner_id as string,
    userId: row.user_id as string,
    codeVerifier: dec.secret,
    redirectPath: safeReturnPath(row.redirect_path as string | null),
    destinationMode: (row.destination_mode as CalendarDestinationMode | null) ?? null,
    requiredEventScope: (row.required_event_scope as string | null) ?? null,
  };
}
