// HON-8 D4: the hosted contract-publication runner's logic. DESIGN: machines/HON8-D4-HOSTED-RUNNER-DESIGN.md (v2), reviewed by
// Insurance (C1-C8) and Privacy (F1-F7). Every effect is injected, so the refusals and the crash behaviour are tested against fakes
// and the module itself holds no key, no URL and no ledger path. NOTHING HERE RUNS UNLESS THE OPERATOR RUNS THE CLI ON THEIR OWN MACHINE.
//
// The only network operations are `select` reads and `.rpc("sync_machine_profile_contract")`. There is no raw table write.
import { createHash } from "node:crypto";

export const ACTION = "publish_machine_contracts";
export const RPC = "sync_machine_profile_contract";
const REF_RE = /^[a-z0-9]{20}$/;
const URL_RE = /^https:\/\/([a-z0-9]{20})\.supabase\.co$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const PROXY_VARS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
const FORBIDDEN_VARS = ["NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "NODE_OPTIONS"];
export const KEY_VAR = "HONE_HOSTED_SERVICE_KEY";
export const URL_VAR = "HONE_HOSTED_URL";

export class Refusal extends Error {}
const refuse = (why) => { throw new Refusal(why); };

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
export const shortFingerprint = (s) => sha256(`hone-ref:${s}`).slice(0, 16);

/** Redact the key, auth header values and anything JWT-shaped from any text that may be printed. */
export function redact(text, key) {
  let out = String(text ?? "");
  if (key) out = out.split(key).join("[redacted-key]");
  return out
    .replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, "[redacted-jwt]")
    .replace(/((?:authorization|apikey)["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s"',}]+/gi, "$1[redacted]");
}

/** F1, C3, F3: everything that must be true BEFORE any key is read or any network call is made. */
export function startupRefusals({ env, execArgv, stdinTTY, stdoutTTY, vpsMarker }) {
  const why = [];
  for (const v of PROXY_VARS) if (env[v] !== undefined && env[v] !== "") why.push(`${v} is set (a proxy could carry the key elsewhere)`);
  for (const v of FORBIDDEN_VARS) if (env[v] !== undefined) why.push(`${v} is set`);
  if (execArgv.some((a) => /^--(inspect|inspect-brk|inspect-wait|debug)(=|$)/.test(a))) why.push("an inspector flag is present");
  if (env.CI) why.push("CI is set: the hosted runner never runs in CI");
  if (env.GITHUB_ACTIONS) why.push("GITHUB_ACTIONS is set: the hosted runner never runs in CI");
  if (!stdinTTY || !stdoutTTY) why.push("stdin and stdout must both be a terminal: a person must run this");
  if (vpsMarker) why.push(`VPS marker present (${vpsMarker}): the hosted runner runs only on the operator's own machine`);
  return why;
}

export function parseHostedUrl(url) {
  const m = URL_RE.exec(String(url ?? ""));
  if (!m) refuse("the hosted URL must be exactly https://<20 lowercase alphanumerics>.supabase.co (no path, port, userinfo or query)");
  return m[1];
}

/** C2: the key's project ref claim if it is a JWT with one; null otherwise. The payload is never returned or printed. */
export function keyRefClaim(key) {
  const parts = String(key).split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.ref === "string" ? payload.ref : null;
  } catch { return null; }
}

/** The planned set as `<profile>@<version>:<mode>` strings, in plan order. */
export function plannedSet(plan) {
  return plan.publish.map((p) => `${p.p_machine_profile_id}@${p.p_machine_profile_version}:${p.p_mode_key}`);
}

/** Parse and check the token against everything the operator's machine can establish. Throws Refusal. */
export function checkToken({ tokenText, expectTokenSha256, plan, planSha256, head, clean, ancestor, now, sysRef, urlRef, productionBranch }) {
  const tokenSha256 = sha256(tokenText);
  if (!SHA_RE.test(String(expectTokenSha256 ?? ""))) refuse("--expect-token-sha256=<64 hex> is required: quote the token's sha256 from the approval message");
  if (tokenSha256 !== expectTokenSha256) refuse(`the token file's sha256 (${tokenSha256}) is not the one quoted; these are not the bytes that were approved`);
  let t;
  try { t = JSON.parse(tokenText); } catch { refuse("the token is not valid JSON"); }
  if (t.action !== ACTION) refuse(`token action must be ${ACTION}`);
  if (t.environment !== "production") refuse('token environment must be "production"');
  if (t.approver_name !== "Sam") refuse("the token must name Sam as the approver");
  const exp = Date.parse(t.expires_at), app = Date.parse(t.approved_at);
  if (!Number.isFinite(exp) || !Number.isFinite(app)) refuse("token approved_at and expires_at must be ISO timestamps");
  if (exp <= now) refuse("the token has expired");
  if (exp - app > 24 * 3600 * 1000) refuse("a token may be valid for at most 24 hours");
  if (!REF_RE.test(String(t.project_ref))) refuse("token project_ref is malformed");
  if (t.project_ref !== urlRef) refuse("token project_ref does not equal the hosted URL's project");
  if (sysRef !== t.project_ref) refuse("token project_ref does not equal supabase/.temp/project-ref");
  if (t.plan_sha256 !== planSha256) refuse("token plan_sha256 is not the plan regenerated from this checkout");
  if (!COMMIT_RE.test(String(t.catalogue_commit)) || t.catalogue_commit !== head) refuse("token catalogue_commit is not this checkout's HEAD");
  if (!clean) refuse("the checkout is not clean (modified or untracked files)");
  if (!ancestor) refuse(`HEAD is not an ancestor of origin/${productionBranch}: this is not the reviewed, merged commit`);
  const planned = plannedSet(plan);
  const scope = Array.isArray(t.scope) ? [...t.scope] : refuse("token scope must be a list");
  if (JSON.stringify([...scope].sort()) !== JSON.stringify([...planned].sort()) || new Set(scope).size !== scope.length) {
    refuse("token scope must EQUAL the planned set exactly (neither more nor less)");
  }
  return { token: t, tokenSha256 };
}

/** What the RPC stores for one planned row, as the comparable projection (mode row plus its field rows, fields sorted). The RPC trims
 *  and defaults exactly like this (0237), so a stored row and a plan row compare equal iff the RPC would call them identical. */
export function projectContract({ channels_max, requires_installed_option, fields }) {
  const norm = (f) => ({
    stage_key: String(f.stage_key ?? "").trim(), field_key: String(f.field_key ?? "").trim(), native_unit: String(f.native_unit ?? "").trim(),
    decimals: Number(f.decimals), quantity: String(f.quantity ?? "").trim(), optional: f.optional ?? false,
    value_kind: f.value_kind ?? "number", choices: f.choices ?? [],
  });
  const list = fields.map(norm).sort((a, b) => `${a.stage_key}\u0000${a.field_key}`.localeCompare(`${b.stage_key}\u0000${b.field_key}`, "en"));
  return { channels_max: channels_max ?? null, requires_installed_option: requires_installed_option ? String(requires_installed_option).trim() : null, fields: list };
}
export const projectPlanRow = (row) => projectContract({ channels_max: row.p_channels_max, requires_installed_option: row.p_requires_installed_option, fields: row.p_fields });

/** The intent and receipt files for one token, in the operator's ledger. */
export const ledgerNames = (tokenSha256) => ({
  intent: `${tokenSha256}.intent.json`,
  receipt: `${tokenSha256}.receipt.json`,
});

/**
 * The whole run. `d` injects every effect. Returns the receipt object; throws Refusal before any write, or a plain Error after one.
 * ORDER (design 3-8): startup refusals, inputs, token, confirmation, connect read-only, fingerprint, ledger intent, reads, writes, read-back, receipt.
 */
export async function runHosted(d) {
  // DRY RUN FIRST and alone: it is what the VPS runs. It never reads the key variable, never touches the network (not even DNS),
  // needs no terminal and no prompt, and writes nothing.
  if (d.dryRun) {
    const { plan, planSha256 } = d.plan();
    return { dryRun: true, planSha256, planned: plannedSet(plan) };
  }
  const reasons = startupRefusals({ env: d.env, execArgv: d.execArgv, stdinTTY: d.stdinTTY, stdoutTTY: d.stdoutTTY, vpsMarker: d.vpsMarker() });
  if (reasons.length) refuse(`refused to start: ${reasons.join("; ")}`);

  const { plan, planSha256 } = d.plan();

  // The key: read once, removed from the environment at once, never passed on.
  const key = d.env[KEY_VAR];
  delete d.env[KEY_VAR];
  if (!key) refuse(`${KEY_VAR} is not set`);
  const urlRef = parseHostedUrl(d.env[URL_VAR]);
  const hostedUrl = d.env[URL_VAR];
  const redactErr = (e) => redact(e instanceof Error ? e.message : e, key);
  try {
    const claim = keyRefClaim(key);
    if (claim !== null && claim !== urlRef) refuse("the service key's project ref claim does not equal the hosted URL's project");
    const keyBinding = claim === null ? "url_only" : "jwt_ref_claim";

    const tokenText = d.readToken();
    const head = d.git(["rev-parse", "HEAD"]);
    const clean = d.git(["status", "--porcelain"]) === "";
    const ancestor = d.isAncestorOfProduction(head);
    const { token, tokenSha256 } = checkToken({
      tokenText, expectTokenSha256: d.expectTokenSha256, plan, planSha256, head, clean, ancestor, now: d.now(),
      sysRef: d.systemRef(), urlRef, productionBranch: d.productionBranch,
    });

    // F3: a person, not a process. Wrong answer = exit, no retry, no skip flag.
    const a1 = (await d.prompt(`Type the first 12 characters of the plan sha256: `)).trim();
    const a2 = (await d.prompt(`Type the last 4 characters of the project ref: `)).trim();
    if (a1 !== planSha256.slice(0, 12) || a2 !== token.project_ref.slice(-4)) refuse("the confirmation did not match");

    // A used token: any intent or receipt in the ledger, or a committed receipt (C1, F2).
    const names = ledgerNames(tokenSha256);
    if (d.ledger.exists(names.intent) || d.ledger.exists(names.receipt) || d.committedReceiptExists(tokenSha256)) {
      refuse("this token has been used or started (an intent record or receipt exists); a started token is cleared only by a person");
    }

    const client = d.client({ url: hostedUrl, key });
    // F4: the hosted fingerprint, read-only, before any write.
    const fp = await client.fingerprint();
    if (fp.migrationMax !== d.declaredMigrationMax()) refuse(`hosted migration max ${fp.migrationMax} is not the declared ${d.declaredMigrationMax()}`);
    if (!fp.rpcExists) refuse(`the ${RPC} function is not present on the target`);
    if (fp.projectKind !== "production") refuse(`the target is not a production project (${fp.projectKind})`);

    // Existing rows, read-only first (design 8.1-8.2).
    const before = [];
    for (const row of plan.publish) {
      const existing = await client.readContract(row);
      before.push({ id: `${row.p_machine_profile_id}@${row.p_machine_profile_version}:${row.p_mode_key}`, hash: existing ? sha256(JSON.stringify(existing)) : null });
      if (existing && sha256(JSON.stringify(existing)) !== sha256(JSON.stringify(projectPlanRow(row)))) {
        refuse(`an existing row differs from the plan (${row.p_mode_key}): rows are immutable, this is an incident, nothing was written`);
      }
    }

    // WRITE-AHEAD INTENT: before the first write, atomically. A crash after this burns the token.
    const startedAt = new Date(d.now()).toISOString();
    d.ledger.writeAtomic(names.intent, JSON.stringify({ token_sha256: tokenSha256, plan_sha256: planSha256, started_at: startedAt }, null, 2));
    d.ledger.writeAtomic(names.receipt, JSON.stringify({ status: "started", token_sha256: tokenSha256, plan_sha256: planSha256, started_at: startedAt }, null, 2));

    const receipt = {
      status: "started",
      plan_sha256: planSha256,
      catalogue_commit: head,
      project_ref_fingerprint: shortFingerprint(token.project_ref),
      approver_role: "owner",
      token_sha256: tokenSha256,
      key_binding: keyBinding,
      runtime: d.runtimeVersions(),
      started_at: startedAt,
      published: [], unchanged: [], not_attempted: [], results: [], before,
    };
    const finish = (status) => {
      receipt.status = status;
      receipt.ended_at = new Date(d.now()).toISOString();
      const body = JSON.stringify(receipt, null, 2);
      try {
        d.ledger.writeAtomic(names.receipt, body);
        d.writeRepoReceipt(tokenSha256, body);
      } catch (e) {
        d.stdout(`RECEIPT WRITE FAILED (${redactErr(e)}); the receipt body follows, keep it:\n${body}`);
        throw new Error("receipt could not be written after publication began");
      }
    };

    let failure = null;
    for (const [i, row] of plan.publish.entries()) {
      const id = plannedSet(plan)[i];
      if (failure) { receipt.not_attempted.push(id); continue; }
      const had = before[i].hash !== null;
      try {
        const out = await client.rpc(RPC, row);
        receipt.results.push({ id, result: String(out) });
        (had ? receipt.unchanged : receipt.published).push(id);
      } catch (e) {
        failure = redactErr(e);
        receipt.results.push({ id, error: failure });
        receipt.not_attempted.push(id);
      }
    }
    // Read-back, byte for byte (design 8.4), for everything that was attempted.
    const mismatches = [];
    for (const row of plan.publish) {
      const id = `${row.p_machine_profile_id}@${row.p_machine_profile_version}:${row.p_mode_key}`;
      if (receipt.not_attempted.includes(id)) continue;
      const now = await client.readContract(row);
      if (!now || sha256(JSON.stringify(now)) !== sha256(JSON.stringify(projectPlanRow(row)))) mismatches.push(id);
    }
    receipt.read_back_mismatches = mismatches;
    receipt.partial = failure !== null;
    finish(failure ? "partial_or_failed_token_burned" : mismatches.length ? "read_back_mismatch" : "complete");
    if (failure) throw new Error(`publication stopped at the first error and the token is burned: ${failure}`);
    if (mismatches.length) throw new Error(`read-back mismatch for: ${mismatches.join(", ")}`);
    return receipt;
  } catch (e) {
    if (e instanceof Refusal) throw e;
    throw new Error(redactErr(e));
  }
}

/** The real hosted client: select reads and the one RPC over https, no redirects, no proxy. */
export function makeHostedClient({ url, key, fetchImpl = fetch }) {
  parseHostedUrl(url);
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const call = async (path, init = {}) => {
    const res = await fetchImpl(`${url}${path}`, { redirect: "manual", ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    if (res.status >= 300 && res.status < 400) throw new Error(`unexpected redirect (${res.status}); refused`);
    if (!res.ok) throw new Error(`hosted request failed (${res.status})`);
    return res.json();
  };
  return {
    // The hosted migration table is not exposed through PostgREST by default; when it is not readable this REFUSES (the runner
    // never proceeds without a fingerprint). A read-only fingerprint RPC would be a migration, which is Sam's category.
    async fingerprint() {
      const rows = await call("/rest/v1/schema_migrations?select=version&order=version.desc&limit=1", { headers: { "Accept-Profile": "supabase_migrations" } })
        .catch(() => { throw new Refusal("the hosted migration max cannot be read through the API; the runner refuses without a fingerprint"); });
      const spec = await call("/rest/v1/", { headers: { Accept: "application/openapi+json" } });
      return {
        migrationMax: String(rows[0]?.version ?? ""),
        rpcExists: Boolean(spec.paths?.[`/rpc/${RPC}`]),
        // Not provable from the REST surface: stated, not faked. Production only when the token says so AND the declared ref matched.
        projectKind: "production",
      };
    },
    async readContract(row) {
      const where = `machine_profile_id=eq.${encodeURIComponent(row.p_machine_profile_id)}&machine_profile_version=eq.${row.p_machine_profile_version}&mode_key=eq.${encodeURIComponent(row.p_mode_key)}`;
      const modes = await call(`/rest/v1/machine_profile_mode_contract?${where}&select=channels_max,requires_installed_option`);
      if (!modes[0]) return null;
      const fields = await call(`/rest/v1/machine_profile_field_contract?${where}&select=stage_key,field_key,native_unit,decimals,quantity,optional,value_kind,choices`);
      return projectContract({ ...modes[0], fields });
    },
    async rpc(name, args) {
      if (name !== RPC) throw new Error("only the contract sync RPC may be called");
      return call(`/rest/v1/rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
    },
  };
}
