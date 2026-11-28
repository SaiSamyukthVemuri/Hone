// Every primitive VALUE in a JSON-shaped object, with the path it sits at. For asserting that a specific value is absent from a result.
//
// WHY NOT `JSON.stringify(x)` + a regex: a substring scan over the whole serialised result also sees random UUIDs and timestamps, so a short
// numeric needle like "9999" matches an id roughly one run in a few hundred and the test goes red for no reason. Checking VALUES by equality, or
// a unique text sentinel by substring on STRING values only, cannot be tripped by an id or a timestamp.
export type Leaf = { path: string; value: string | number | boolean | null };

export function jsonLeaves(x: unknown, path = "$"): Leaf[] {
  if (x === null || typeof x !== "object") {
    return typeof x === "string" || typeof x === "number" || typeof x === "boolean" || x === null ? [{ path, value: x }] : [];
  }
  if (Array.isArray(x)) return x.flatMap((v, i) => jsonLeaves(v, `${path}[${i}]`));
  return Object.entries(x as Record<string, unknown>).flatMap(([k, v]) => jsonLeaves(v, `${path}.${k}`));
}

/** Paths of leaves that EQUAL one of the given numbers, or are strings CONTAINING one of the given text sentinels. */
export function leavesLeaking(x: unknown, opts: { numbers?: number[]; texts?: string[] }): string[] {
  return jsonLeaves(x)
    .filter(
      (l) =>
        (typeof l.value === "number" && (opts.numbers ?? []).includes(l.value)) ||
        (typeof l.value === "string" && (opts.texts ?? []).some((t) => (l.value as string).includes(t))),
    )
    .map((l) => l.path);
}
