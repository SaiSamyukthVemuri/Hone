// A PostgREST `.or()` clause list, parsed the way PostgREST parses it, so a
// fake cannot accept a filter the real server would reject or read differently.
//
// "col.op.value,col.op.value". A value ends at the next comma unless it is
// double-quoted; inside quotes a backslash escapes the next character (so \"
// and \\ are a literal quote and backslash). An UNQUOTED value may not carry
// a reserved `(`, `)` or `"`: PostgREST rejects that filter, and the fake
// throws so the test sees it.

export type OrClause = { col: string; op: string; value: string };

export function parseOrFilter(expr: string): OrClause[] {
  const clauses: OrClause[] = [];
  let i = 0;
  while (i < expr.length) {
    const colEnd = expr.indexOf(".", i);
    const opEnd = colEnd < 0 ? -1 : expr.indexOf(".", colEnd + 1);
    if (colEnd < 0 || opEnd < 0) throw new Error(`malformed .or clause at ${i}: ${expr}`);
    const col = expr.slice(i, colEnd);
    const op = expr.slice(colEnd + 1, opEnd);
    i = opEnd + 1;
    let value = "";
    if (expr[i] === '"') {
      i++;
      for (;;) {
        if (i >= expr.length) throw new Error(`unterminated quoted value: ${expr}`);
        const ch = expr[i++];
        if (ch === "\\") {
          if (i >= expr.length) throw new Error(`dangling escape: ${expr}`);
          value += expr[i++];
        } else if (ch === '"') break;
        else value += ch;
      }
      if (i < expr.length && expr[i] !== ",") throw new Error(`text after a quoted value: ${expr}`);
    } else {
      const end = expr.indexOf(",", i);
      value = expr.slice(i, end < 0 ? expr.length : end);
      if (/[()"]/.test(value)) throw new Error(`reserved character in an unquoted value: ${value}`);
      i = end < 0 ? expr.length : end;
    }
    clauses.push({ col, op, value });
    if (expr[i] === ",") i++;
  }
  return clauses;
}
