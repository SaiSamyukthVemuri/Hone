// ===========================================================================
// APPLICATION REACHABILITY THROUGH THE DATABASE — the closure behind "dead"
// ===========================================================================
//
// A resource may be called DEAD only when no application-reachable path can
// read or write it. Two earlier versions of that check were too narrow and both
// were caught in review:
//
//   writers only     missed `appointment_payments`, which is READ by
//                    reschedule_appointment_v2 and
//                    appointment_has_blocking_dependents;
//   direct only      missed indirection — an application RPC that reaches a
//                    resource through a helper, and a table write whose TRIGGER
//                    function reaches it. The function that actually touches the
//                    table is never named in application source, so looking only
//                    at "functions the app calls" sees nothing.
//
// This module is the closure those two versions were missing. It is PURE: the
// caller supplies the graph, so the same algorithm runs against the real
// pg_catalog and against fixtures, and the fixtures can express shapes the
// installed schema happens not to contain.
//
// OVER-APPROXIMATION IS DELIBERATE, IN ONE DIRECTION ONLY. Reaching a table is
// treated as potentially WRITING it, so the table's trigger functions AND the
// children its foreign-key actions can mutate are followed. Telling a read from a write by inspecting a function body is not
// reliable, and the asymmetry is the safe one: it can only ever make a `dead`
// claim harder to sustain, never easier. The same reasoning applies to
// function-to-function edges, which are name mentions rather than a parsed call
// graph.

export type ReachabilityGraph = {
  /** Function name -> the function names its body mentions. */
  readonly functionCalls: Readonly<Record<string, readonly string[]>>;
  /** Function name -> the table names its body mentions, read or write. */
  readonly functionTables: Readonly<Record<string, readonly string[]>>;
  /** Table name -> the trigger functions a write to it fires. */
  readonly tableTriggers: Readonly<Record<string, readonly string[]>>;
  /**
   * Referenced (parent) table -> referencing (child) tables a FOREIGN KEY
   * ACTION can mutate when the parent changes.
   *
   * Codex P2 on 327b3487. Under the rule above — reaching a table is treated as
   * possibly writing it — a reachable parent can therefore CASCADE, SET NULL or
   * SET DEFAULT into a child the application never names anywhere. That child
   * is written by the database on the application's behalf, so calling it
   * unreachable was wrong. `ON DELETE RESTRICT` and `NO ACTION` raise instead
   * of mutating and are deliberately NOT edges.
   */
  readonly tableFkActions: Readonly<Record<string, readonly string[]>>;
  /** Functions the application names directly (an RPC call site). */
  readonly appFunctions: readonly string[];
  /** Tables the application opens directly. */
  readonly appTables: readonly string[];
};

export type Reachability = {
  readonly functions: ReadonlySet<string>;
  readonly tables: ReadonlySet<string>;
  /** For each reached table, one path from an application entrypoint. */
  readonly pathTo: ReadonlyMap<string, string>;
};

type Node = { kind: "fn" | "table"; name: string };
const key = (n: Node) => `${n.kind}:${n.name}`;

/**
 * Breadth-first closure from the application's entrypoints.
 *
 * CYCLE-SAFE BY CONSTRUCTION: a node is enqueued only when it is first marked
 * visited, so a cyclic function graph is walked once and terminates. There is
 * no recursion and therefore no stack to overflow on a long chain.
 */
export function computeReachability(graph: ReachabilityGraph): Reachability {
  const visited = new Set<string>();
  const parent = new Map<string, string>();
  const queue: Node[] = [];

  const push = (node: Node, from: string | null): void => {
    const k = key(node);
    if (visited.has(k)) return;
    visited.add(k);
    if (from !== null) parent.set(k, from);
    queue.push(node);
  };

  for (const name of graph.appFunctions) push({ kind: "fn", name }, null);
  for (const name of graph.appTables) push({ kind: "table", name }, null);

  while (queue.length > 0) {
    const node = queue.shift()!;
    const here = key(node);
    if (node.kind === "fn") {
      for (const callee of graph.functionCalls[node.name] ?? []) {
        push({ kind: "fn", name: callee }, here);
      }
      for (const table of graph.functionTables[node.name] ?? []) {
        push({ kind: "table", name: table }, here);
      }
    } else {
      // Reaching a table is treated as possibly writing it, so its triggers
      // are live too. See the header: the over-approximation is deliberate.
      for (const fn of graph.tableTriggers[node.name] ?? []) {
        push({ kind: "fn", name: fn }, here);
      }
      // ...and so are the children a foreign-key ACTION can mutate on its
      // behalf. Same visited set, so an FK cycle terminates like any other.
      for (const child of graph.tableFkActions[node.name] ?? []) {
        push({ kind: "table", name: child }, here);
      }
    }
  }

  const functions = new Set<string>();
  const tables = new Set<string>();
  for (const k of visited) {
    const [kind, ...rest] = k.split(":");
    const name = rest.join(":");
    if (kind === "fn") functions.add(name);
    else tables.add(name);
  }

  const pathTo = new Map<string, string>();
  for (const table of tables) {
    const steps: string[] = [];
    let cursor: string | undefined = `table:${table}`;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      steps.unshift(cursor.replace("fn:", "").replace("table:", ""));
      cursor = parent.get(cursor);
    }
    pathTo.set(table, ["app", ...steps].join(" -> "));
  }

  return { functions, tables, pathTo };
}

/**
 * The resources that claim to be dead but are reachable, each with the path
 * that reaches it. Empty means every dead claim holds.
 */
export function deadClaimViolations(
  deadResources: readonly string[],
  reach: Reachability,
): string[] {
  return deadResources
    .filter((resource) => reach.tables.has(resource))
    .map((resource) => `${resource} is reachable: ${reach.pathTo.get(resource)}`)
    .sort();
}

// ---------------------------------------------------------------------------
// FOREIGN-KEY ACTION EDGES
// ---------------------------------------------------------------------------
//
// pg_constraint stores the action as a single character on confdeltype
// (ON DELETE) and confupdtype (ON UPDATE):
//
//     c  CASCADE       deletes/updates the child row     -> MUTATES
//     n  SET NULL      nulls the child's columns         -> MUTATES
//     d  SET DEFAULT   rewrites the child's columns      -> MUTATES
//     a  NO ACTION     raises; the child is unchanged    -> not an edge
//     r  RESTRICT      raises; the child is unchanged    -> not an edge
//
// Only the mutating three become edges, and the edge runs PARENT -> CHILD,
// which is the direction the write actually travels. Kept pure and separate
// from the query so every action code can be exercised without a database.

export type FkConstraintRow = {
  readonly parent_table: string;
  readonly child_table: string;
  readonly confdeltype: string;
  readonly confupdtype: string;
};

export const MUTATING_FK_ACTIONS: ReadonlySet<string> = new Set(["c", "n", "d"]);

export function fkActionEdges(
  rows: readonly FkConstraintRow[],
): Record<string, string[]> {
  const edges: Record<string, string[]> = {};
  for (const row of rows) {
    if (
      !MUTATING_FK_ACTIONS.has(row.confdeltype) &&
      !MUTATING_FK_ACTIONS.has(row.confupdtype)
    ) {
      continue;
    }
    const children = (edges[row.parent_table] ??= []);
    if (!children.includes(row.child_table)) children.push(row.child_table);
  }
  return edges;
}
