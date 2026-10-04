// ---------------------------------------------------------------------------
// WIKI-AUTO-01: the runner's environment contract, by NAME only.
//
// These lists are also the closed set of environment names a report may
// carry (scripts/openwiki/report.mjs). A variable that is forbidden only
// because of its prefix is reported by that prefix, never by its full name:
// the rest of the name is host state, not something the runner owns.
// ---------------------------------------------------------------------------

/** Names the host must set (values live in the host env file; secrets only as *_FILE paths). */
export const REQUIRED_ENV = Object.freeze([
  "HONE_WIKI_NIGHTLY",
  "HONE_WIKI_REPOSITORY",
  "HONE_WIKI_BASE_BRANCH",
  "HONE_WIKI_SUBJECT_DIR",
  "HONE_WIKI_STATE_DIR",
  "HONE_WIKI_APP_ID",
  "HONE_WIKI_APP_INSTALLATION_ID",
  "HONE_WIKI_APP_PRIVATE_KEY_FILE",
  "HONE_WIKI_GIT_AUTHOR_NAME",
  "HONE_WIKI_GIT_AUTHOR_EMAIL",
  "HONE_WIKI_OPENWIKI_DIR",
  "HONE_WIKI_ANTHROPIC_API_KEY_FILE",
  "HONE_WIKI_DENYLIST_FILE",
  "OPENWIKI_PROVIDER",
  "OPENWIKI_MODEL_ID",
  "OPENWIKI_TELEMETRY_DISABLED",
  "DO_NOT_TRACK",
]);
export const OPTIONAL_ENV = Object.freeze(["HONE_WIKI_PUBLISH", "HONE_WIKI_MIN_FREE_GB", "HONE_WIKI_RUN_TIMEOUT_MIN"]);

/**
 * Must be absent from the runner's environment. Operator GitHub tokens would
 * bypass the App's narrowed permissions. A raw provider key in the runner's
 * own environment would reach every child, not only OpenWiki; it arrives as a
 * file. Tracing would ship repository content to LangSmith. The runner holds
 * no production credential.
 */
export const FORBIDDEN_ENV = Object.freeze([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_COMPATIBLE_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "LANGSMITH_API_KEY",
  "LANGCHAIN_API_KEY",
  "LANGCHAIN_TRACING_V2",
  "OPENWIKI_LANGSMITH_API_KEY",
]);
export const FORBIDDEN_ENV_PREFIXES = Object.freeze(["SUPABASE_", "STRIPE_", "TWILIO_", "VERCEL_", "SENTRY_"]);

/** Required names whose value is fixed. */
export const ENV_VALUE_RULES = Object.freeze({ OPENWIKI_PROVIDER: "anthropic", OPENWIKI_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1" });

/** Every name a report may carry. */
export const KNOWN_ENV_NAMES = Object.freeze([...REQUIRED_ENV, ...OPTIONAL_ENV, ...FORBIDDEN_ENV]);

/**
 * Problems with the runner environment, as report reasons ({ code, details }).
 * Values are never read into a reason.
 */
export function checkEnvironment(env, required = REQUIRED_ENV) {
  const reasons = [];
  for (const name of required) {
    if (!String(env[name] ?? "").trim()) reasons.push({ code: "REQUIRED_ENV_MISSING", details: { name } });
  }
  const prefixCounts = new Map();
  for (const name of Object.keys(env).sort()) {
    if (FORBIDDEN_ENV.includes(name)) {
      reasons.push({ code: "FORBIDDEN_ENV_PRESENT", details: { name } });
      continue;
    }
    const prefix = FORBIDDEN_ENV_PREFIXES.find((p) => name.startsWith(p));
    if (prefix) prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
  }
  for (const [prefix, count] of prefixCounts) reasons.push({ code: "FORBIDDEN_ENV_PREFIX_PRESENT", details: { prefix, count } });
  for (const [name, expected] of Object.entries(ENV_VALUE_RULES)) {
    if (required.includes(name) && env[name] && env[name] !== expected) reasons.push({ code: "ENV_VALUE_INVALID", details: { name } });
  }
  return reasons;
}
