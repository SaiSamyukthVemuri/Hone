// ---------------------------------------------------------------------------
// ENG-LOOP V1 05B: trust policy (ARCH-01 §20). Authority is the numeric GitHub
// actor id PLUS the expected account type; logins never authorize. 05A carries
// identities; only 05B decides whom to trust.
// ---------------------------------------------------------------------------

export const TRUST_POLICY = Object.freeze({
  /** Trusted Codex reviewers: REST users/chatgpt-codex-connector[bot] -> 199175422, Bot (2026-10-05). */
  codex: Object.freeze([Object.freeze({ id: 199175422, type: "Bot" })]),
  /** Human resolvers: REST users/SaiSamyukthVemuri -> 26781116, User (2026-10-05). */
  humanResolvers: Object.freeze([Object.freeze({ id: 26781116, type: "User" })]),
});
