// Refusals that run BEFORE anything is dropped, written to the database, or cached. Pure functions over facts the
// CLI measures, so each refusal is unit-tested. `restore` and `seal` are DESTRUCTIVE: they drop the public and
// supabase_migrations schemas of the stack they point at.
import path from "node:path";

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/;
const portOf = (url) => {
  try {
    return Number(new URL(url).port);
  } catch {
    return NaN;
  }
};
const hostOf = (url) => {
  try {
    return new URL(url).hostname === "::1" ? "[::1]" : new URL(url).hostname;
  } catch {
    return "";
  }
};

/**
 * @param {{container:string, destructive:boolean, env:Record<string,string|undefined>, confirmOwned?:string,
 *          dockerContext:string, contextEndpoint:string, publishedDbPort?:number}} f
 * @returns {string[]} reasons to refuse; empty means go ahead
 */
export function guardProblems(f) {
  const problems = [];
  if (f.env.DOCKER_HOST) problems.push("DOCKER_HOST is set: the baseline only ever talks to the local docker daemon");
  if (f.dockerContext !== "default" || !String(f.contextEndpoint).startsWith("unix://")) {
    problems.push(`the docker context is not the local default (context "${f.dockerContext}", endpoint "${f.contextEndpoint}")`);
  }
  const m = /^supabase_db_([A-Za-z0-9_.-]+)$/.exec(f.container || "");
  if (!m) {
    problems.push("--container must be a local supabase_db_<project> container");
    return problems;
  }
  if (!f.destructive) return problems;

  const project = m[1];
  if (f.confirmOwned !== undefined) {
    if (f.confirmOwned !== project) problems.push(`--confirm-owned "${f.confirmOwned}" does not name this stack's project "${project}"`);
    return problems;
  }
  const api = f.env.E2E_SUPABASE_URL;
  const db = f.env.HONE_LOCAL_DB_URL;
  if (!api || !db) {
    problems.push("this command drops schemas: set the paired E2E_SUPABASE_URL and HONE_LOCAL_DB_URL of the stack you own, or pass --confirm-owned <project>");
    return problems;
  }
  if (!LOOPBACK.test(hostOf(api)) || !LOOPBACK.test(hostOf(db))) problems.push("E2E_SUPABASE_URL and HONE_LOCAL_DB_URL must both be loopback");
  if (portOf(db) !== portOf(api) + 1) problems.push("E2E_SUPABASE_URL and HONE_LOCAL_DB_URL are not one stack (the database is expected on the API port + 1)");
  if (f.publishedDbPort === undefined || portOf(db) !== f.publishedDbPort) {
    problems.push(`HONE_LOCAL_DB_URL (port ${portOf(db)}) is not this container's published database port (${f.publishedDbPort ?? "unknown"}): it is not the stack you own`);
  }
  return problems;
}

/**
 * The cache is an owner-set directory OUTSIDE the repository, never a default and never a path in the source.
 */
export function cacheDirProblems(cacheDir, repoRoot) {
  if (!cacheDir) return ["no cache directory: set HONE_DB_BASELINE_CACHE (an owner-set directory outside the repo) or pass --cache"];
  const abs = path.resolve(cacheDir);
  const rel = path.relative(path.resolve(repoRoot), abs);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return ["the cache directory must be outside the repository"];
  return [];
}

/**
 * `build` refuses unless the database holds only synthetic, migration-seeded data: no auth user, and rows only in the
 * allowed reference tables. Returns the reasons, naming every unexpected table.
 * @param {{authUsers:number, rowCounts:Record<string,number>, allowedSeeded:string[]}} f
 */
export function syntheticProblems(f) {
  const problems = [];
  if (f.authUsers !== 0) problems.push(`auth.users has ${f.authUsers} rows; a baseline is built only from a database with none`);
  const allowed = new Set(f.allowedSeeded);
  const unexpected = Object.entries(f.rowCounts).filter(([t, n]) => n > 0 && !allowed.has(t)).map(([t, n]) => `${t} (${n})`).sort();
  if (unexpected.length) problems.push(`rows in tables that are not allowed migration-seeded reference tables: ${unexpected.join(", ")}`);
  return problems;
}
