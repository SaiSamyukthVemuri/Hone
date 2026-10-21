// Bounded source matcher shared only by the 0212/0227 delivery grant contracts.
// This enumerates top-level GRANTs; real privilege closure is proved in DB tests.
// Preserve literal boundaries so comments or semicolons inside them cannot hide
// a following statement. Unknown GRANT syntax fails closed rather than vanishing.
function statements(sql: string): string[] {
  const out: string[] = [];
  let statement = "";
  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i + 2);
      i = end < 0 ? sql.length : end + 1;
      statement += " ";
    } else if (sql.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith("/*", i)) { depth++; i += 2; }
        else if (sql.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
      if (depth > 0) throw new Error("Unterminated SQL block comment");
      statement += " ";
    } else if (sql[i] === "'" || sql[i] === '"') {
      const start = i;
      const quote = sql[i++]!;
      const escaped = quote === "'" && /e/i.test(sql[start - 1] ?? "") &&
        !/[a-z0-9_$]/i.test(sql[start - 2] ?? "");
      let closed = false;
      while (i < sql.length) {
        if (escaped && sql[i] === "\\") { i += 2; continue; }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) throw new Error("Unterminated SQL quoted value");
      statement += sql.slice(start, i);
    } else {
      const dollar = sql[i] === "$" && !/[a-z0-9_$]/i.test(sql[i - 1] ?? "")
        ? /^\$(?:[a-z_][a-z0-9_]*)?\$/i.exec(sql.slice(i))?.[0]
        : undefined;
      if (dollar) {
        const end = sql.indexOf(dollar, i + dollar.length);
        if (end < 0) throw new Error("Unterminated SQL dollar quote");
        statement += sql.slice(i, end + dollar.length);
        i = end + dollar.length;
      } else if (sql[i] === ";") {
        out.push(statement);
        statement = "";
        i++;
      } else {
        statement += sql[i++];
      }
    }
  }
  if (statement.trim()) out.push(statement);
  return out;
}

export function emailDeliveryGrants(sql: string): string[] {
  const out: string[] = [];
  for (const statement of statements(sql)) {
    if (/^\s*alter\s+default\s+privileges\b/i.test(statement) && /\bgrant\b/i.test(statement)) {
      throw new Error("Unsupported top-level GRANT in ALTER DEFAULT PRIVILEGES");
    }
    if (!/^\s*grant\b/i.test(statement)) continue;
    const match = /^\s*grant\s+([\s\S]+?)\s+on\s+([\s\S]+?)\s+to\s+([\s\S]+?)\s*$/i.exec(statement);
    if (!match) {
      // Includes membership/no-ON grants such as GRANT service_role TO anon.
      throw new Error("Unsupported top-level GRANT: " + statement.trim());
    }
    const privilege = match[1]!.replace(/\s+/g, " ").trim().toLowerCase();
    const object = match[2]!.replace(/\s+/g, " ").trim().replace(/^function /i, "");
    for (const role of match[3]!.split(",")) {
      out.push(privilege + " | " + object + " -> " + role.trim().toLowerCase());
    }
  }
  return out.sort();
}
