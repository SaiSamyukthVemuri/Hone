// ---------------------------------------------------------------------------
// ENG-LOOP V1 05A, row 6: the head commit's status-check rollup contexts, from
// ONE GraphQL response (CAP-01 §17). The reader validates the schema: a null or
// non-string state/status, a non-string conclusion and a missing or empty app
// slug are `malformed` here, so EXT-CONTEXT-01's binder only ever sees
// schema-valid records (EXT-CONTEXT-01 §3). A `null` rollup is a complete,
// empty set of contexts.
// ---------------------------------------------------------------------------

import {
  fail,
  graphqlData,
  hasExactly,
  isNonEmptyString,
  isNonNegInt,
  isObject,
  okRecord,
} from "../../../contract/strict.mjs";

const LIMIT = 100;

export const ROLLUP_QUERY =
  "query($owner:String!,$name:String!,$h:GitObjectID!){repository(owner:$owner,name:$name){object(oid:$h){" +
  "__typename ... on Commit{statusCheckRollup{contexts(first:100){totalCount pageInfo{hasNextPage} nodes{" +
  "__typename ... on CheckRun{name status conclusion checkSuite{app{slug}}} ... on StatusContext{context state}}}}}}}}";

function context(n) {
  if (!isObject(n)) return null;
  if (n.__typename === "CheckRun") {
    if (!hasExactly(n, ["__typename", "name", "status", "conclusion", "checkSuite"])) return null;
    if (typeof n.name !== "string" || !isNonEmptyString(n.status)) return null;
    if (!(n.conclusion === null || typeof n.conclusion === "string")) return null;
    if (!isObject(n.checkSuite) || !hasExactly(n.checkSuite, ["app"])) return null;
    const app = n.checkSuite.app;
    if (!(app === null || (isObject(app) && hasExactly(app, ["slug"]) && isNonEmptyString(app.slug)))) return null;
    return {
      kind: "CheckRun",
      name: n.name,
      status: n.status,
      conclusion: n.conclusion,
      appSlug: app === null ? null : app.slug,
    };
  }
  if (n.__typename === "StatusContext") {
    if (!hasExactly(n, ["__typename", "context", "state"])) return null;
    if (typeof n.context !== "string" || !isNonEmptyString(n.state)) return null;
    return { kind: "StatusContext", context: n.context, state: n.state };
  }
  return null;
}

export function parseRollup(raw) {
  const env = graphqlData(raw);
  if (env.failure) return env.failure;
  const data = env.data;
  if (!hasExactly(data, ["repository"])) return fail("malformed", "data is not exactly { repository }");
  if (data.repository === null) return fail("read_failed", "the repository is not visible to this credential");
  if (!isObject(data.repository) || !hasExactly(data.repository, ["object"])) {
    return fail("malformed", "repository is not exactly { object }");
  }
  const o = data.repository.object;
  if (o === null) return fail("read_failed", "the head commit is not readable");
  if (!isObject(o) || !hasExactly(o, ["__typename", "statusCheckRollup"]) || o.__typename !== "Commit") {
    return fail("malformed", "the head object is not a Commit with a rollup");
  }
  if (o.statusCheckRollup === null) return okRecord({ contexts: [] });
  const r = o.statusCheckRollup;
  if (!isObject(r) || !hasExactly(r, ["contexts"])) return fail("malformed", "the rollup is not exactly { contexts }");
  const c = r.contexts;
  if (!isObject(c) || !hasExactly(c, ["totalCount", "pageInfo", "nodes"])) return fail("malformed", "contexts");
  if (!isObject(c.pageInfo) || !hasExactly(c.pageInfo, ["hasNextPage"]) || typeof c.pageInfo.hasNextPage !== "boolean") {
    return fail("malformed", "contexts pageInfo");
  }
  if (!isNonNegInt(c.totalCount) || !Array.isArray(c.nodes)) return fail("malformed", "contexts fields");
  const contexts = [];
  for (const n of c.nodes) {
    const parsed = context(n);
    if (parsed === null) return fail("malformed", "a rollup context is not a schema-valid CheckRun or StatusContext");
    contexts.push(parsed);
  }
  if (c.pageInfo.hasNextPage || c.totalCount > LIMIT || c.totalCount !== c.nodes.length) {
    return fail("external_contexts_too_large", "the rollup's contexts do not fit one complete response");
  }
  return okRecord({ contexts });
}
