import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { appointmentCreationSurface, buildCensus, insertsAppointment, sameArityGroups, scan, unknownInserters, type Census } from "./helpers/function-census";

// ===========================================================================
// WHICH FUNCTIONS CREATE AN APPOINTMENT: pinned, and fail closed.
// ===========================================================================
//
// The booking request key (a later change) has to be carried by EVERY command that can create an appointment. This test finds those commands from the
// migrations as they stand at the latest one and pins the list, so a new command that inserts an appointment (or one that calls an existing one) fails
// here until it is reviewed and either carries the key or is named on purpose.
//
// FAIL CLOSED. A function whose latest definition the scanner cannot read counts as an UNKNOWN INSERTER, never as absent; a drop it cannot match keeps the
// function; a rename, a function created inside a string, and two live definitions with one name and arity are all reported and must be empty or named.
//
// SCOPE HONESTY. This is a census of FUNCTION definitions in the migration files. It does not see: a top-level `insert into appointments` in a data
// migration (a one-time backfill, not a command), a direct insert from application code (a different guard covers the routes), or the hosted database's
// actual state (the migration files are the source of truth only until the hosted apply record says otherwise).

const DIR = "supabase/migrations";
const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(`${DIR}/${name}`, "utf8") }));
const census = buildCensus(files);
const surface = appointmentCreationSurface(census);

describe("the real migrations", () => {
  it("the census read the whole chain (so an empty result cannot pass on a missing directory)", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(census.functions.size).toBeGreaterThan(300);
    expect(files[0].name < files[files.length - 1].name).toBe(true);
  });

  it("nothing is unreadable, unmatched, renamed or dynamic: there is no UNKNOWN inserter", () => {
    expect(unknownInserters(census)).toEqual([]);
  });

  it("no two live definitions share a name and arity (a real overload must be named here; today there is none)", () => {
    expect(sameArityGroups(census)).toEqual([]);
  });

  it("the functions that INSERT an appointment themselves are exactly these", () => {
    expect(surface.direct).toEqual(["create_appointment_core/11", "create_public_appointment/7", "create_public_appointment_v2/8", "reschedule_appointment_v3/6"]);
  });

  it("the functions that reach an insert only by calling another command are exactly these (the booking request key has to be threaded through each)", () => {
    expect(surface.viaCalls).toEqual([
      "create_internal_appointment_v2/10",
      "create_public_appointment_for_new_client/13",
      "create_public_appointment_for_new_client_v2/14",
      "create_waitlist_public_appointment/8",
      "receptionist_create_appointment/5",
      "redeem_and_book_waitlist_invitation/14",
      "reschedule_appointment_v2/6",
    ]);
  });

  it("the legacy commands stay gone: no un-versioned reschedule, no un-versioned internal create, and no other reschedule-named function appears", () => {
    const names = [...census.functions.values()].map((f) => f.name);
    expect(names).not.toContain("reschedule_appointment");
    expect(names).not.toContain("create_internal_appointment");
    expect(names.filter((n) => /reschedule_appointment/.test(n)).sort()).toEqual(["reschedule_appointment_v2", "reschedule_appointment_v3"]);
    expect(names.filter((n) => /^create_internal_appointment/.test(n)).sort()).toEqual(["create_internal_appointment_v2"]);
  });

  it("the one command that inserts a replacement appointment sets the lineage column in its insert", () => {
    const v3 = [...census.functions.values()].find((f) => f.name === "reschedule_appointment_v3");
    expect(v3 && insertsAppointment(v3)).toBe(true);
    expect(v3?.body).toMatch(/rescheduled_from_appointment_id/);
    // and the insert statement itself carries it (not just a comment or a read)
    const insert = /insert\s+into\s+(?:public\.)?appointments(?:\s+as\s+\w+)?\s*\(([\s\S]*?)\)\s*(?:values|select)/i.exec(v3?.body ?? "");
    expect(insert?.[1]).toMatch(/rescheduled_from_appointment_id/);
  });
});

// ---- the census itself, on synthetic SQL: each case is a shape the real files could take tomorrow ----------------------------------------------------

const run = (...sqls: string[]) => buildCensus(sqls.map((sql, i) => ({ name: `${String(i + 1).padStart(4, "0")}_t.sql`, sql })));
const fn = (name: string, body: string, args = "p uuid") => `create or replace function public.${name}(${args}) returns void language plpgsql as $$ begin ${body} end; $$;`;
const direct = (c: Census) => appointmentCreationSurface(c).direct;

describe("what counts as an insert", () => {
  it("a plain insert, an unqualified one, a quoted one and an `only` one all count", () => {
    for (const stmt of ["insert into public.appointments (id) values (1);", "insert into appointments(id) values (1);", 'insert into "public"."appointments" (id) values (1);', "insert into only public.appointments select 1;", "INSERT\n INTO\n public.appointments select 1;", "merge into public.appointments a using t on true when not matched then insert default values;"]) {
      expect(direct(run(fn("f", stmt))), stmt).toEqual(["f/1"]);
    }
  });
  it("a similarly named table, a read, an update or a comment is not an insert", () => {
    for (const stmt of ["insert into public.appointments_archive (id) values (1);", "insert into public.waitlist_appointments (id) values (1);", "select * from public.appointments;", "update public.appointments set notes = 'x';", "-- insert into public.appointments (id) values (1);", "/* insert into public.appointments (id) values (1); */ perform 1;"]) {
      expect(direct(run(fn("f", stmt))), stmt).toEqual([]);
    }
  });
  it("an insert written inside a string (dynamic SQL) DOES count", () => {
    expect(direct(run(fn("f", "execute 'insert into public.appointments (id) values (1)';")))).toEqual(["f/1"]);
    expect(direct(run(fn("f", "execute format('insert into %I.appointments select 1', 'public');")))).toEqual([]); // honest limit: a name built at run time is not visible; see SCOPE HONESTY
  });
  it("a `--` inside a string literal does not hide the insert after it", () => {
    expect(direct(run(fn("f", "perform '--'; insert into public.appointments (id) values (1);")))).toEqual(["f/1"]);
  });
  it("nested block comments, odd dollar tags and a nested dollar body are read correctly", () => {
    const sql = `create function public.g(p uuid) returns void language plpgsql as $fn$ begin /* a /* nested */ still comment */ perform $q$ -- not a comment $q$; insert into public.appointments (id) values (1); end; $fn$;`;
    expect(direct(run(sql))).toEqual(["g/1"]);
  });
});

describe("the LATEST definition wins", () => {
  it("a later create-or-replace that no longer inserts removes the function from the inserters", () => {
    expect(direct(run(fn("f", "insert into public.appointments (id) values (1);"), fn("f", "perform 1;")))).toEqual([]);
  });
  it("a later definition that starts inserting adds it", () => {
    expect(direct(run(fn("f", "perform 1;"), fn("f", "insert into public.appointments (id) values (1);")))).toEqual(["f/1"]);
  });
  it("one function spelled two ways is ONE function: timestamptz and timestamp with time zone, int and integer", () => {
    const a = fn("f", "insert into public.appointments (id) values (1);", "p_at timestamptz, p_n int");
    const b = fn("f", "perform 1;", "p_at timestamp with time zone, p_n integer");
    expect(direct(run(a, b))).toEqual([]);
    expect(sameArityGroups(run(a, b))).toEqual([]);
  });
  it("a new trailing parameter is a NEW overload, and the old one is still live until it is dropped", () => {
    const old = fn("f", "insert into public.appointments (id) values (1);", "p uuid");
    const next = fn("f", "insert into public.appointments (id) values (1);", "p uuid, p_request_key text default null");
    const c = run(old, next);
    expect(direct(c)).toEqual(["f/1", "f/2"]);
    expect(direct(run(old, next, "drop function public.f(uuid);"))).toEqual(["f/2"]);
    expect(sameArityGroups(c)).toEqual([]);
  });
  it("a default value does not change a function's identity", () => {
    const a = fn("f", "insert into public.appointments (id) values (1);", "p uuid, p_k text");
    const b = fn("f", "perform 1;", "p uuid, p_k text default null");
    expect(direct(run(a, b))).toEqual([]);
  });
});

describe("drops", () => {
  it("drop function removes it, with or without if exists, schema or cascade", () => {
    const ins = fn("f", "insert into public.appointments (id) values (1);");
    for (const drop of ["drop function public.f(uuid);", "drop function if exists f(uuid) cascade;", 'drop function "public"."f"(uuid);']) expect(direct(run(ins, drop)), drop).toEqual([]);
  });
  it("a drop that matches two same-arity overloads keeps BOTH and is reported as ambiguous", () => {
    const a = fn("f", "insert into public.appointments (id) values (1);", "p uuid");
    const b = fn("f", "insert into public.appointments (id) values (1);", "p text");
    const c = run(a, b, "drop function public.f(jsonb);");
    expect(direct(c)).toEqual(["f/1", "f/1"]);
    expect(c.ambiguousDrops).toHaveLength(1);
    expect(sameArityGroups(c)).toEqual(["f/1"]);
  });
});

describe("FAIL CLOSED: what the scanner cannot read is an unknown inserter, never absent", () => {
  it("a create function with no readable body", () => {
    const c = run("create function public.f(p uuid) returns void language plpgsql;");
    expect(unknownInserters(c)).toHaveLength(1);
    expect(c.unparseable[0].reason).toMatch(/no readable body/);
  });
  it("a create function with no readable name or argument list", () => {
    const c = run("create function !!! returns void as $$ select 1 $$ language sql;");
    expect(unknownInserters(c)).toHaveLength(1);
  });
  it("a LATEST body that cannot be read, after an earlier one that could, still fails (the older one is not trusted as current)", () => {
    const c = run(fn("f", "perform 1;"), "create or replace function public.f(p uuid) returns void language plpgsql;");
    expect(unknownInserters(c)).toHaveLength(1);
    expect(direct(c)).toEqual([]); // the readable older body inserts nothing: the unknown list is what catches the unreadable newer one
  });
  it("a file that ends inside a dollar quote, a string or a comment", () => {
    for (const tail of ["create function public.f(p uuid) returns void language plpgsql as $$ begin insert into public.appointments (id) values (1);", "select 'unclosed", "select 1; /* never closed"]) {
      const c = run(tail);
      expect(unknownInserters(c), tail).not.toEqual([]);
      expect(scan(tail).unterminated, tail).toBe(true);
    }
  });
  it("an alter function rename or set schema", () => {
    expect(unknownInserters(run(fn("f", "perform 1;"), "alter function public.f(uuid) rename to g;"))).toHaveLength(1);
    expect(unknownInserters(run(fn("f", "perform 1;"), "alter function public.f(uuid) set schema other;"))).toHaveLength(1);
  });
  it("a function created inside a string (a DO block or an execute)", () => {
    expect(unknownInserters(run("do $$ begin execute 'create function public.f(p uuid) returns void language sql as $x$ select 1 $x$'; end $$;"))).toHaveLength(1);
  });
  it("a clean chain reports nothing unknown", () => {
    expect(unknownInserters(run(fn("f", "perform 1;"), fn("g", "insert into public.appointments (id) values (1);")))).toEqual([]);
  });
});

describe("callers: reaching an insert by calling a command counts", () => {
  const core = fn("core", "insert into public.appointments (id) values (1);");
  it("a direct caller and a caller of that caller are both on the surface", () => {
    const c = run(core, fn("mid", "perform core(p);"), fn("top", "perform public.mid(p);"));
    expect(appointmentCreationSurface(c)).toEqual({ direct: ["core/1"], viaCalls: ["mid/1", "top/1"] });
  });
  it("a longer name that merely contains the command's name is not a caller", () => {
    const c = run(core, fn("other", "perform xcore(p); perform core_two(p); perform recore(p);"));
    expect(appointmentCreationSurface(c).viaCalls).toEqual([]);
  });
  it("a caller that stops calling it (a later definition) leaves the surface", () => {
    const c = run(core, fn("mid", "perform core(p);"), fn("mid", "perform 1;"));
    expect(appointmentCreationSurface(c).viaCalls).toEqual([]);
  });
});
