import { classifyNanpNumber } from "../../../lib/sms/nanp";
import type { InboundStopFacts } from "../../../lib/sms/inbound-stop-preflight";

// ===========================================================================
// HON-50 G6 operator script: the FACTS FILE, validated field by field.
// ===========================================================================
//
// The operator assembles these facts read-only (Twilio Console / API, the
// production deployment's settings, an approved live STOP). Every field is
// checked for type and shape. A field that is missing or malformed is DROPPED,
// so the evaluator sees it as not read and the checklist item it feeds is
// UNKNOWN, never pass. Nothing here decides a status: only
// evaluateInboundStopPreflight does.
//
// SECRETS NEVER ENTER. The auth token is reported as presence only
// (`deployment.authTokenSet`). A file that carries anything that looks like a
// secret value is refused outright, before anything else is read.
//
// IDENTITY IS NEVER TAKEN FROM THE FILE. The sender's Messaging Service, its
// number, the routed From, and the service->studio mapping are read from the
// target database by the script (run.ts). Values for them in the file are
// ignored and reported.

export const FACTS_FILE_VERSION = 1;

export type SanitizedFacts = {
  facts: Omit<InboundStopFacts, "expectedStudioId" | "mappedStudioId" | "routedFromNumber">;
  /** Paths of fields that were present but malformed, so treated as not read. */
  malformed: string[];
  /** Paths of identity fields the file supplied and the script ignored. */
  ignored: string[];
};

export type FactsRefusal = { refused: "not_an_object" | "wrong_facts_version" | "secret_in_facts" };

const SECRET_KEY = /token|secret|password|api[_-]?key|private/i;
const MG = /^MG[0-9a-fA-F]{32}$/;
const AC = /^AC[0-9a-fA-F]{32}$/;
const AP = /^AP[0-9a-fA-F]{32}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Any key that names a secret and carries a string or number value is refused. */
function carriesSecret(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(carriesSecret);
  if (!isObj(v)) return false;
  return Object.entries(v).some(
    ([k, x]) => (SECRET_KEY.test(k) && (typeof x === "string" || typeof x === "number")) || carriesSecret(x),
  );
}

export function sanitizeFacts(raw: unknown, nowMs: number): SanitizedFacts | FactsRefusal {
  if (!isObj(raw)) return { refused: "not_an_object" };
  if (raw.factsVersion !== FACTS_FILE_VERSION) return { refused: "wrong_facts_version" };
  if (carriesSecret(raw)) return { refused: "secret_in_facts" };

  const malformed: string[] = [];
  const ignored: string[] = [];

  // Field readers: each returns the value, or undefined (and records why).
  const at = (o: Obj | undefined, key: string, path: string) => {
    if (!o || !(key in o)) return { present: false as const, v: undefined };
    return { present: true as const, v: o[key], path: `${path}.${key}` };
  };
  function read<T>(o: Obj | undefined, key: string, path: string, ok: (v: unknown) => v is T): T | undefined {
    const f = at(o, key, path);
    if (!f.present) return undefined;
    if (ok(f.v)) return f.v;
    malformed.push(f.path);
    return undefined;
  }
  const str = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && v.length <= 2048;
  const strOrNull = (v: unknown): v is string | null => v === null || str(v);
  const bool = (v: unknown): v is boolean => typeof v === "boolean";
  const boolOrNull = (v: unknown): v is boolean | null => v === null || bool(v);
  const intIn = (lo: number, hi: number) => (v: unknown): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  const intOrNullIn = (lo: number, hi: number) => (v: unknown): v is number | null => v === null || intIn(lo, hi)(v);
  const httpsUrl = (v: unknown): v is string => {
    if (!str(v)) return false;
    try {
      return new URL(v).protocol === "https:";
    } catch {
      return false;
    }
  };
  const urlOrNull = (v: unknown): v is string | null => v === null || httpsUrl(v);
  // An observation time must parse and must not be in the future.
  const pastIso = (v: unknown): v is string => str(v) && Number.isFinite(Date.parse(v)) && Date.parse(v) <= nowMs;
  const pastIsoOrNull = (v: unknown): v is string | null => v === null || pastIso(v);
  const e164 = (v: unknown): v is string => {
    if (!str(v)) return false;
    const c = classifyNanpNumber(v);
    return c.ok && c.e164 === v;
  };
  const sidMG = (v: unknown): v is string => str(v) && MG.test(v);
  const sidACOrNull = (v: unknown): v is string | null => v === null || (str(v) && AC.test(v));
  const sidAPOrNull = (v: unknown): v is string | null => v === null || (str(v) && AP.test(v));
  const method = (v: unknown): v is string | null => v === null || (str(v) && /^(GET|POST)$/i.test(v));

  // ---- deployment: production's settings, never the operator's laptop ----
  const dep = isObj(raw.deployment) ? raw.deployment : undefined;
  if (raw.deployment !== undefined && !dep) malformed.push("deployment");
  const base = read(dep, "webhookBaseUrl", "deployment", httpsUrl);
  const tokenSet = read(dep, "authTokenSet", "deployment", bool);
  const appOrigin = read(dep, "appOrigin", "deployment", httpsUrl);
  const accountSid = read(dep, "accountSid", "deployment", sidACOrNull);
  const env: Record<string, string | undefined> = {
    TWILIO_WEBHOOK_BASE_URL: base,
    // Presence only: the evaluator needs a non-empty value, never the token.
    TWILIO_AUTH_TOKEN: tokenSet === true ? "present" : tokenSet === false ? "" : undefined,
    NEXT_PUBLIC_APP_ORIGIN: appOrigin,
  };

  const facts: SanitizedFacts["facts"] = { env, honeAccountSid: accountSid };

  // ---- signature proof ----
  if (raw.signatureProof !== undefined) {
    const sp = isObj(raw.signatureProof) ? raw.signatureProof : undefined;
    if (!sp) malformed.push("signatureProof");
    else {
      const last = read(sp, "lastVerifiedCallbackAt", "signatureProof", pastIsoOrNull);
      const since = read(sp, "credentialsActiveSince", "signatureProof", pastIsoOrNull);
      facts.signatureProof = { lastVerifiedCallbackAt: last ?? null, credentialsActiveSince: since ?? null };
    }
  }

  // ---- endpoint probe ----
  if (raw.endpointProbe !== undefined) {
    const ep = isObj(raw.endpointProbe) ? raw.endpointProbe : undefined;
    const status = read(ep, "status", "endpointProbe", intIn(100, 599));
    const redirectedTo = read(ep, "redirectedTo", "endpointProbe", urlOrNull);
    if (!ep || status === undefined || redirectedTo === undefined) {
      if (!ep) malformed.push("endpointProbe");
    } else facts.endpointProbe = { status, redirectedTo };
  }

  // ---- the studio's service and number (identity comes from the database) ----
  if (raw.service !== undefined) {
    const sv = isObj(raw.service) ? raw.service : undefined;
    if (!sv) malformed.push("service");
    else {
      for (const k of ["sid", "checkedNumber"]) if (k in sv) ignored.push(`service.${k}`);
      const service: NonNullable<InboundStopFacts["service"]> = {};
      const set = <K extends keyof typeof service>(k: K, v: (typeof service)[K] | undefined) => {
        if (v !== undefined) service[k] = v;
      };
      set("inboundRequestUrl", read(sv, "inboundRequestUrl", "service", urlOrNull));
      set("useInboundWebhookOnNumber", read(sv, "useInboundWebhookOnNumber", "service", boolOrNull));
      set("numberSmsUrl", read(sv, "numberSmsUrl", "service", urlOrNull));
      set("inboundMethod", read(sv, "inboundMethod", "service", method));
      set("numberSmsMethod", read(sv, "numberSmsMethod", "service", method));
      set("numberSmsApplicationSid", read(sv, "numberSmsApplicationSid", "service", sidAPOrNull));
      set("accountSid", read(sv, "accountSid", "service", sidACOrNull));
      set("fallbackUrl", read(sv, "fallbackUrl", "service", urlOrNull));
      set("fallbackMethod", read(sv, "fallbackMethod", "service", method));
      set("numberSmsFallbackUrl", read(sv, "numberSmsFallbackUrl", "service", urlOrNull));
      set("numberSmsFallbackMethod", read(sv, "numberSmsFallbackMethod", "service", method));
      if ("senderPool" in sv) {
        // All or nothing: one malformed member makes the pool unread.
        const pool = sv.senderPool;
        const members = Array.isArray(pool)
          ? pool.map((m) =>
              isObj(m) &&
              e164(m.phoneNumber) &&
              (m.smsUrl === undefined || urlOrNull(m.smsUrl)) &&
              (m.smsMethod === undefined || method(m.smsMethod)) &&
              (m.smsApplicationSid === undefined || sidAPOrNull(m.smsApplicationSid)) &&
              (m.smsFallbackUrl === undefined || urlOrNull(m.smsFallbackUrl)) &&
              (m.smsFallbackMethod === undefined || method(m.smsFallbackMethod))
                ? {
                    phoneNumber: m.phoneNumber as string,
                    smsUrl: m.smsUrl as string | null | undefined,
                    ...(m.smsMethod !== undefined ? { smsMethod: m.smsMethod as string | null } : {}),
                    ...(m.smsApplicationSid !== undefined ? { smsApplicationSid: m.smsApplicationSid as string | null } : {}),
                    ...(m.smsFallbackUrl !== undefined ? { smsFallbackUrl: m.smsFallbackUrl as string | null } : {}),
                    ...(m.smsFallbackMethod !== undefined ? { smsFallbackMethod: m.smsFallbackMethod as string | null } : {}),
                  }
                : null,
            )
          : null;
        if (!members || members.some((m) => m === null)) malformed.push("service.senderPool");
        else service.senderPool = members as NonNullable<typeof service.senderPool>;
      }
      facts.service = service;
    }
  }
  if ("routedFromNumber" in raw) ignored.push("routedFromNumber");
  if ("mappedStudioId" in raw) ignored.push("mappedStudioId");
  if ("expectedStudioId" in raw) ignored.push("expectedStudioId");

  // ---- account Webhook Rules: all or nothing ----
  if (raw.webhookRules !== undefined) {
    const wr = raw.webhookRules;
    const setting = (s: unknown) =>
      isObj(s) &&
      (s.settingType === undefined || s.settingType === null || s.settingType === "SYSTEM" || s.settingType === "CUSTOMER") &&
      intOrNullIn(0, 100)(s.percentage) &&
      strOrNull(s.authScheme) &&
      strOrNull(s.signatureType) &&
      strOrNull(s.signatureAlgorithm) &&
      (s.retryOn === null || (Array.isArray(s.retryOn) && s.retryOn.every(str))) &&
      intOrNullIn(0, 5)(s.retryCount) &&
      (s.totalTimeoutMs === undefined || intOrNullIn(100, 60000)(s.totalTimeoutMs)) &&
      (s.connectTimeoutMs === undefined || intOrNullIn(100, 10000)(s.connectTimeoutMs)) &&
      (s.readTimeoutMs === undefined || intOrNullIn(100, 15000)(s.readTimeoutMs)) &&
      (s.edgeZones === null ||
        s.edgeZones === "omitted" ||
        (isObj(s.edgeZones) &&
          Array.isArray(s.edgeZones.zones) &&
          s.edgeZones.zones.every((z) => typeof z === "string" && ID.test(z)) &&
          (s.edgeZones.allowZoneFallback === undefined || boolOrNull(s.edgeZones.allowZoneFallback))));
    if (isObj(wr) && wr.matched === false) facts.webhookRules = { matched: false };
    else if (isObj(wr) && wr.matched === true && Array.isArray(wr.settings) && wr.settings.length > 0 && wr.settings.every(setting)) {
      facts.webhookRules = { matched: true, settings: wr.settings as never };
    } else malformed.push("webhookRules");
  }

  if (raw.webhookPropagation !== undefined) {
    const p = raw.webhookPropagation;
    const statuses = isObj(p) ? p.ruleOperationStatuses : undefined;
    const secs = isObj(p) ? p.secondsSinceLastConfigChange : undefined;
    const statusesOk = statuses === null || (Array.isArray(statuses) && statuses.every(str));
    const secsOk = secs === null || (Number.isInteger(secs) && (secs as number) >= 0);
    if (isObj(p) && statusesOk && secsOk) {
      facts.webhookPropagation = { ruleOperationStatuses: statuses as string[] | null, secondsSinceLastConfigChange: secs as number | null };
    } else malformed.push("webhookPropagation");
  }

  facts.staticProxyEnabled = read(raw, "staticProxyEnabled", "$", boolOrNull);

  if (raw.edgeZoneCatalog !== undefined) {
    const c = raw.edgeZoneCatalog;
    if (Array.isArray(c) && c.every((z) => isObj(z) && typeof z.id === "string" && ID.test(z.id) && intIn(0, 1000)(z.activeEdgeLocations))) {
      facts.edgeZoneCatalog = c as Array<{ id: string; activeEdgeLocations: number }>;
    } else malformed.push("edgeZoneCatalog");
  }

  // ---- the approved live STOP (operator-entered, strictly validated) ----
  if (raw.liveStopObservation !== undefined) {
    const lo = isObj(raw.liveStopObservation) ? raw.liveStopObservation : undefined;
    if (!lo) malformed.push("liveStopObservation");
    else {
      const reachedRoute = read(lo, "reachedRoute", "liveStopObservation", boolOrNull);
      const routeStatus = read(lo, "routeStatus", "liveStopObservation", intOrNullIn(100, 599));
      const stamped = read(lo, "phoneWideOptOutStamped", "liveStopObservation", boolOrNull);
      facts.liveStopObservation = {
        reachedRoute: reachedRoute ?? null,
        routeStatus: routeStatus ?? null,
        phoneWideOptOutStamped: stamped ?? null,
        observedAt: read(lo, "observedAt", "liveStopObservation", pastIso),
        toNumber: read(lo, "toNumber", "liveStopObservation", e164),
        messagingServiceSid: read(lo, "messagingServiceSid", "liveStopObservation", sidMG),
      };
    }
  }

  if (raw.currentActivation !== undefined) {
    const ca = isObj(raw.currentActivation) ? raw.currentActivation : undefined;
    if (!ca) malformed.push("currentActivation");
    else {
      facts.currentActivation = {
        handlerDeployedAt: read(ca, "handlerDeployedAt", "currentActivation", pastIsoOrNull) ?? null,
        databaseMigratedAt: read(ca, "databaseMigratedAt", "currentActivation", pastIsoOrNull) ?? null,
      };
    }
  }

  if (raw.optOutConfiguration !== undefined) {
    const oc = isObj(raw.optOutConfiguration) ? raw.optOutConfiguration : undefined;
    if (!oc) malformed.push("optOutConfiguration");
    else {
      facts.optOutConfiguration = {
        dropsKeywordMessages: read(oc, "dropsKeywordMessages", "optOutConfiguration", boolOrNull) ?? null,
        lastChangedAt: read(oc, "lastChangedAt", "optOutConfiguration", pastIsoOrNull) ?? null,
      };
    }
  }

  return { facts, malformed, ignored };
}
