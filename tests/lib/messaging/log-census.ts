import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

// MSG-007. The analyzer behind messaging-log-census.test.ts.
//
// A "log writer" is a console.* or safeLog.* call (the two ways a line reaches
// the runtime log drain, a third party), or a call to a file-local helper that
// forwards a caller's object into one ("logEvent(event, fields)"). Every writer
// is reduced to what it can put on the line, read from the source alone:
//   * names: every key, identifier and property segment in a written value;
//   * literals: every string written as is;
//   * errorText: values that are raw error or provider text (err.message,
//     result.error, a bare caught error), which no source rule can prove clean;
//   * opaque: values the source does not show (an element access, a function).
// A const declared once in the same function is followed to its initializer, so
// `const payload = JSON.stringify({...}); console.error(payload)` is read whole.
// Line numbers are reported but never pinned: moving code is free, adding a
// writer is not.

export const SURFACE_DIRS = [
  "lib/sms",
  "lib/email",
  "lib/waitlist",
  "lib/notifications",
  "lib/portal-messages",
  "app/api/twilio",
  "app/api/cron",
] as const;

// Any application file that imports a messaging module is on the surface too:
// that is where a recipient, a link or a message body is in scope.
export const SURFACE_IMPORT_RE =
  'from "@/lib/(sms|email|waitlist|notifications|portal-messages)[/"]';

export type Writer = {
  file: string;
  line: number;
  /** "console.error", "safeLog.info", or "logEvent()" for a helper call. */
  via: string;
  /** The first non-blank string written: the event name, for a readable key. */
  label: string;
  text: string;
  names: string[];
  literals: string[];
  errorText: string[];
  opaque: string[];
};

export type FileCensus = {
  writers: Writer[];
  /** A forwarding helper that is exported or anonymous: its callers cannot be followed. */
  unfollowable: string[];
};

const SINK_OBJECTS = new Set(["console", "safeLog"]);

// A property that carries raw error or provider text.
const ERROR_PROPS = new Set(["message", "error", "stack", "details", "hint", "cause"]);
// A bare identifier that names a caught error or a provider error object.
const ERROR_NAME_RE = /^(?:e|err|error|\w*(?:Err|Error))$/;
// Functions whose RESULT may be written: a bounded vocabulary, a number, a
// deployment label or a one-way digest. VERIFIED BY READING, not by pattern:
// each entry names the file that declares it (a test checks the declaration is
// there), and a function not listed has an unresolved result (fail closed).
// `sanitizes: true` means the arguments are not written either: only the
// bounded result is.
export type VerifiedFunction = { file: string; returns: string; sanitizes?: true };
export const VERIFIED_FUNCTIONS: Readonly<Record<string, VerifiedFunction>> = {
  smsTypeForLog: { file: "lib/sms/send-appointment.ts", returns: "one of three SMS types, or \"unknown\"", sanitizes: true },
  smsAttemptForLog: { file: "lib/sms/send-appointment.ts", returns: "an integer 1-3, or null", sanitizes: true },
  smsFailureForLog: { file: "lib/sms/send-appointment.ts", returns: "a tag from SMS_LOG_FAILURES, twilio_http_NNN, or provider_or_transport", sanitizes: true },
  emailTypeForLog: { file: "lib/email/send-appointment.ts", returns: "a type from EMAIL_LOG_TYPES, or \"unknown\"", sanitizes: true },
  emailAttemptForLog: { file: "lib/email/send-appointment.ts", returns: "an integer 1-3, or null", sanitizes: true },
  hashFingerprint: { file: "lib/portal/tokens.ts", returns: "a salted SHA-256 hex digest, or null", sanitizes: true },
  hashId: { file: "lib/rate-limit/public.ts", returns: "a truncated SHA-256 hex digest", sanitizes: true },
  currentEnvironment: { file: "lib/rate-limit/public.ts", returns: "VERCEL_ENV / NODE_ENV, or \"unknown\": operator configuration" },
  environmentLabel: { file: "lib/ops/alert-email.ts", returns: "VERCEL_ENV / NODE_ENV, or \"unknown\": operator configuration" },
  retryAfterSeconds: { file: "lib/rate-limit/public.ts", returns: "a number of seconds" },
  errorCodeOf: { file: "app/api/twilio/message-status/route.ts", returns: "a positive integer of at most 8 digits, or null" },
  normalizeTwilioMessageStatus: { file: "lib/sms/delivery-ledger.ts", returns: "a ProviderDeliveryStatus, or null" },
  eligibilitySkip: { file: "lib/waitlist/delivery/sms.ts", returns: "\"opted_out\", \"no_consent\" or null (same function in join-ack-sms.ts)" },
  missingSuccessFields: { file: "app/reschedule/[token]/actions.ts", returns: "names from the constant REQUIRED_SUCCESS_FIELDS" },
  "Math.min": { file: "builtin", returns: "a number" },
};
// Array or string methods whose result, on a verified function's result, is
// still made only of that result (missingSuccessFields(row).join(",")).
const PRESERVING_METHODS = new Set(["join", "trim", "toString", "toLowerCase", "toUpperCase"]);
// Method calls whose result is a timestamp or a number whatever the receiver.
const SAFE_METHODS = new Set(["toISOString", "toFixed", "getTime"]);
// Constructors whose result is safe to write: a Date serialises as a timestamp.
const SAFE_CONSTRUCTORS = new Set(["Date"]);
// Names that do not say what a value holds. One of these, written whole and not
// resolved to what it holds, cannot be judged by the name rule, so it is
// UNRESOLVED (fail closed) rather than clean.
const CONTAINER_WORDS = new Set([
  "payload", "detail", "data", "fields", "row", "rows", "result", "res", "response", "input",
  "args", "params", "opts", "options", "context", "ctx", "meta", "metadata", "extra", "info",
  "obj", "object", "value", "values", "item", "record", "raw", "props", "parsed", "json", "out",
]);
// Binary operators whose result is a boolean or a number, whatever the operands.
const SCALAR_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.InstanceOfKeyword, ts.SyntaxKind.InKeyword,
  ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken,
  ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.BarToken, ts.SyntaxKind.CaretToken,
]);
// Operators that write an operand: the value is one side, or both joined.
const PASS_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.PlusToken,
]);
// Operators whose value is the right operand: x = y, x ??= y, (a, b).
const RIGHT_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.CommaToken,
]);

// Every method of console and safeLog is a sink (console.dir and console.table
// write too), and so is a direct write to process.stdout or process.stderr.
export function isSink(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const target = node.expression.expression;
  if (ts.isIdentifier(target) && SINK_OBJECTS.has(target.text)) return true;
  return node.expression.name.text === "write" && /^process\.(stdout|stderr)$/.test(target.getText());
}

// A sink object used any other way (aliased, passed as a value, indexed) hides
// its writes from the census, so it is reported, never ignored.
function isSinkReference(node: ts.Node): boolean {
  if (!ts.isIdentifier(node) || !SINK_OBJECTS.has(node.text)) return false;
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    return !(ts.isCallExpression(parent.parent) && parent.parent.expression === parent);
  }
  // A declaration or import of the name itself is not a use.
  return !(ts.isImportSpecifier(parent) || ts.isVariableDeclaration(parent) || ts.isPropertyAccessExpression(parent));
}

type Fn = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;

function isFn(n: ts.Node): n is Fn {
  return ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n);
}

function enclosingFunction(node: ts.Node): Fn | undefined {
  for (let n = node.parent; n; n = n.parent) if (isFn(n)) return n;
  return undefined;
}

function functionName(fn: Fn): string | undefined {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) return fn.parent.name.text;
  return undefined;
}

function isExported(fn: Fn): boolean {
  const holder = ts.isVariableDeclaration(fn.parent) ? fn.parent.parent.parent : fn;
  return !!(ts.canHaveModifiers(holder) && ts.getModifiers(holder)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

type Declared =
  | { kind: "const"; init: ts.Expression }
  | { kind: "param" | "catch" | "binding" | "let" | "loop" | "import" | "function" | "ambiguous" | "none" };

// What a bare identifier is bound to, searching outward from where it is used.
function declarationOf(id: ts.Identifier): Declared {
  for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
    if (ts.isCatchClause(n) && n.variableDeclaration && n.variableDeclaration.name.getText() === id.text) return { kind: "catch" };
    if (isFn(n) && n.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === id.text)) return { kind: "param" };
    if (isFn(n) || ts.isSourceFile(n)) {
      const found: Declared[] = [];
      const walk = (m: ts.Node): void => {
        if (m !== n && isFn(m)) {
          if (ts.isFunctionDeclaration(m) && m.name?.text === id.text) found.push({ kind: "function" });
          return;
        }
        if (ts.isVariableDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === id.text) {
          const list = m.parent;
          const loop = ts.isVariableDeclarationList(list) && (ts.isForOfStatement(list.parent) || ts.isForInStatement(list.parent));
          if (loop) found.push({ kind: "loop" });
          else if (ts.isVariableDeclarationList(list) && list.flags & ts.NodeFlags.Const && m.initializer) found.push({ kind: "const", init: m.initializer });
          else found.push({ kind: "let" });
        }
        if (ts.isBindingElement(m) && ts.isIdentifier(m.name) && m.name.text === id.text) found.push({ kind: "binding" });
        if ((ts.isImportSpecifier(m) || ts.isImportClause(m) || ts.isNamespaceImport(m)) && m.name?.text === id.text) found.push({ kind: "import" });
        ts.forEachChild(m, walk);
      };
      ts.forEachChild(n, walk);
      if (found.length === 1) return found[0];
      if (found.length > 1) return { kind: "ambiguous" };
    }
  }
  return { kind: "none" };
}

// The verified function a call's result comes from, if any: a listed function
// called directly, or a preserving method on such a call's result.
function verifiedCall(call: ts.CallExpression): VerifiedFunction | undefined {
  const text = call.expression.getText();
  if (Object.hasOwn(VERIFIED_FUNCTIONS, text)) return VERIFIED_FUNCTIONS[text];
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee) && PRESERVING_METHODS.has(callee.name.text)) {
    let receiver: ts.Expression = callee.expression;
    while (ts.isParenthesizedExpression(receiver)) receiver = receiver.expression;
    if (ts.isCallExpression(receiver)) {
      const inner = verifiedCall(receiver);
      if (inner) return { file: inner.file, returns: inner.returns };
    }
  }
  return undefined;
}

function lastWordOf(name: string): string {
  const words = wordsOf(name);
  return words[words.length - 1] ?? "";
}

type Acc = Pick<Writer, "names" | "literals" | "errorText" | "opaque"> & {
  /** Identifiers written whole, not through a property. */
  bare: string[];
  /** Functions whose result's `error` is a closed category by type. */
  closed: ReadonlySet<string>;
};

function newAcc(closed: ReadonlySet<string> = new Set()): Acc {
  return { names: [], literals: [], errorText: [], opaque: [], bare: [], closed };
}

// MSG-LOG-RAW-ERROR. `x.error` is closed text, not raw, when `x` is a const
// holding the (awaited) result of a sender whose result type makes `error` a
// closed category: the exported senders of lib/email/send-appointment.ts that
// return Promise<EmailSendResult> (see closedResultFunctions).
function isClosedResult(root: ts.Expression, closed: ReadonlySet<string>): boolean {
  if (!ts.isIdentifier(root) || closed.size === 0) return false;
  const declared = declarationOf(root);
  let init: ts.Expression | undefined = declared.kind === "const" ? declared.init : undefined;
  while (init && (ts.isAwaitExpression(init) || ts.isParenthesizedExpression(init))) init = init.expression;
  return !!init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && closed.has(init.expression.text);
}

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

function segmentsOf(expr: ts.Expression): string[] {
  return expr.getText().replace(/\?\./g, ".").split(".").filter((s) => IDENT_RE.test(s));
}

// `whole` is false inside an ordinary call's arguments: there an identifier is
// an input to the function (formDataStr(formData, "id")), not what is written,
// so it is still checked by name but is never treated as a forwarded object.
function walkValue(expr: ts.Expression, acc: Acc, skip: ReadonlySet<string>, depth = 0, whole = true): void {
  if (depth > 12) {
    acc.opaque.push(expr.getText());
    return;
  }
  const next = (e: ts.Expression, w = whole) => walkValue(e, acc, skip, depth + 1, w);
  if (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isAwaitExpression(expr)
  ) {
    return next(expr.expression);
  }
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    acc.literals.push(expr.text);
    return;
  }
  if (ts.isTemplateExpression(expr)) {
    acc.literals.push(expr.head.text);
    for (const span of expr.templateSpans) {
      acc.literals.push(span.literal.text);
      next(span.expression);
    }
    return;
  }
  if (
    ts.isNumericLiteral(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(expr) && expr.text === "undefined")
  ) {
    return;
  }
  if (ts.isObjectLiteralExpression(expr)) {
    for (const prop of expr.properties) {
      if (ts.isPropertyAssignment(prop)) {
        acc.names.push(prop.name.getText().replace(/^["']|["']$/g, ""));
        next(prop.initializer);
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        next(prop.name);
      } else if (ts.isSpreadAssignment(prop)) {
        next(prop.expression);
      } else {
        acc.opaque.push(prop.getText());
      }
    }
    return;
  }
  if (ts.isArrayLiteralExpression(expr)) {
    for (const e of expr.elements) next(ts.isSpreadElement(e) ? e.expression : e);
    return;
  }
  if (ts.isIdentifier(expr)) {
    if (skip.has(expr.text)) return;
    acc.names.push(expr.text);
    if (whole) acc.bare.push(expr.text);
    if (ERROR_NAME_RE.test(expr.text)) {
      acc.errorText.push(expr.text);
      return;
    }
    if (!whole) return;
    const declared = declarationOf(expr);
    if (declared.kind === "const") return next(declared.init);
    // A caught value is an error whatever it is called.
    if (declared.kind === "catch") return void acc.errorText.push(expr.text);
    // A name that says what it holds is judged by the name rule; one that does
    // not (payload, detail, result, ...) and could not be followed is unresolved.
    if (CONTAINER_WORDS.has(lastWordOf(expr.text))) acc.errorText.push(`unresolved ${declared.kind} ${expr.text}`);
    return;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    acc.names.push(...segmentsOf(expr));
    const closedText = expr.name.text === "error" && isClosedResult(expr.expression, acc.closed);
    if (ERROR_PROPS.has(expr.name.text) && !closedText) acc.errorText.push(expr.getText());
    else if (!closedText && whole && CONTAINER_WORDS.has(lastWordOf(expr.name.text))) acc.errorText.push(`unresolved property ${expr.getText()}`);
    return;
  }
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression;
    const calleeName = ts.isPropertyAccessExpression(callee) ? callee.name.text : callee.getText();
    if (ts.isPropertyAccessExpression(callee) && SAFE_METHODS.has(calleeName)) return;
    const writesArgs = calleeName === "stringify" || calleeName === "String";
    if (!writesArgs) acc.names.push(calleeName);
    const verified = verifiedCall(expr);
    if (verified?.sanitizes) return;
    if (ts.isPropertyAccessExpression(callee) && !writesArgs) next(callee.expression, false);
    expr.arguments.forEach((a) => next(a, whole && writesArgs));
    // Any other call's RESULT is what is written, and the source does not show
    // it: its name and inputs are checked above, its value is unresolved.
    if (whole && !writesArgs && !verified) acc.errorText.push(`unresolved call ${callee.getText()}()`);
    return;
  }
  if (ts.isConditionalExpression(expr)) {
    // The condition decides; only the branches are written.
    next(expr.whenTrue);
    next(expr.whenFalse);
    return;
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (PASS_OPERATORS.has(op)) {
      next(expr.left);
      next(expr.right);
      return;
    }
    if (RIGHT_OPERATORS.has(op)) return next(expr.right);
    // A comparison, instanceof, in or arithmetic writes a boolean or a number.
    if (SCALAR_OPERATORS.has(op)) return;
    if (whole) acc.opaque.push(expr.getText());
    return;
  }
  if (ts.isPrefixUnaryExpression(expr) || ts.isTypeOfExpression(expr) || ts.isVoidExpression(expr)) {
    // !x, -x, +x, ~x, typeof x, void x: a boolean, a number, a type word, undefined.
    return;
  }
  if (ts.isNewExpression(expr)) {
    const ctor = expr.expression.getText();
    if (SAFE_CONSTRUCTORS.has(ctor)) return; // new Date(...) writes a timestamp
    // Any other constructor can serialise what it was given (new URL(link)),
    // so its arguments are read as written, and its result is not trusted.
    for (const a of expr.arguments ?? []) next(a);
    if (whole) acc.errorText.push(/Error$/.test(ctor) ? `new ${ctor}` : `unresolved new ${ctor}`);
    return;
  }
  if (whole) acc.opaque.push(expr.getText());
}

// `positions`: the arguments that reach the line. A sink writes all of them; a
// helper call writes only the ones the helper forwards (postCommit(event,
// undefined, () => ...) writes `event`, not its callback).
function writerOf(
  file: string,
  node: ts.CallExpression,
  via: string,
  skip: ReadonlySet<string>,
  closed: ReadonlySet<string>,
  positions?: readonly number[],
): Writer {
  const acc = newAcc(closed);
  node.arguments.forEach((a, i) => {
    if (!positions || positions.includes(i)) walkValue(a, acc, skip);
  });
  const src = node.getSourceFile();
  return {
    file,
    line: src.getLineAndCharacterOfPosition(node.getStart()).line + 1,
    via,
    // With no string at all, the first name written ("{outcome}") stands in.
    label: acc.literals.find((l) => l.trim().length > 0)?.trim() ?? (acc.names[0] ? `{${acc.names[0]}}` : ""),
    text: node.getText().replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " "),
    names: acc.names,
    literals: acc.literals,
    errorText: acc.errorText,
    opaque: acc.opaque,
  };
}

/**
 * The parameters of `fn` that `call` writes whole (not through a property).
 * Their type does not matter: a `string` parameter can be a payload serialised
 * by the caller (logEmailDiagnostic(JSON.stringify({...})), Codex P2
 * 4368011462), so every caller is followed whatever the parameter is.
 */
function containerParams(fn: Fn, call: ts.CallExpression): number[] {
  const acc = newAcc();
  for (const a of call.arguments) walkValue(a, acc, new Set());
  const out: number[] = [];
  fn.parameters.forEach((p, i) => {
    if (ts.isIdentifier(p.name) && acc.bare.includes(p.name.text)) out.push(i);
  });
  return out;
}

/** Every log writer in one source file. */
export function analyzeSource(file: string, source: string, closed: ReadonlySet<string> = new Set()): FileCensus {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const src = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const writers: Writer[] = [];
  const unfollowable: string[] = [];
  // helper name -> the positions of the parameters it forwards
  const forwarders = new Map<string, { fn: Fn; positions: number[] }>();

  const paramNames = (fn: Fn, positions: readonly number[]) =>
    positions.map((i) => fn.parameters[i]?.name.getText()).filter((n): n is string => !!n);

  const addForwarder = (fn: Fn, positions: number[]) => {
    const name = functionName(fn);
    if (!name || isExported(fn)) {
      const entry = `${name ?? "<anonymous>"}(${paramNames(fn, positions).join(", ")})`;
      if (!unfollowable.includes(entry)) unfollowable.push(entry);
      return;
    }
    const known = forwarders.get(name);
    if (known) known.positions = [...new Set([...known.positions, ...positions])];
    else forwarders.set(name, { fn, positions });
  };

  const visitSinks = (n: ts.Node): void => {
    if (isSink(n)) {
      // A parameter of ANY enclosing function can reach the line, not only the
      // innermost one's (after(() => console.error(JSON.stringify(detail)))).
      // A forwarded parameter is judged at each call of a followable helper; an
      // exported or anonymous one cannot be, so it is judged here by name.
      const skip = new Set<string>();
      for (let fn = enclosingFunction(n); fn; fn = enclosingFunction(fn)) {
        const positions = containerParams(fn, n).filter((i) => !skip.has(fn.parameters[i].name.getText()));
        if (positions.length === 0) continue;
        if (functionName(fn) && !isExported(fn)) for (const name of paramNames(fn, positions)) skip.add(name);
        addForwarder(fn, positions);
      }
      writers.push(writerOf(file, n, n.expression.getText(), skip, closed));
    }
    if (isSinkReference(n)) unfollowable.push(`sink used as a value: ${n.parent.getText().slice(0, 80)}`);
    ts.forEachChild(n, visitSinks);
  };
  visitSinks(src);

  // Follow every forwarding helper to each call in the file. A caller that
  // hands its own object parameter to a forwarded position is a helper too.
  const followed = new Set<string>();
  for (let progressed = true; progressed; ) {
    progressed = false;
    for (const [name, { fn, positions }] of [...forwarders]) {
      if (followed.has(name)) continue;
      followed.add(name);
      progressed = true;
      const visitCalls = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
          const outer = enclosingFunction(n);
          const outerFollowable = !!outer && !!functionName(outer) && !isExported(outer);
          const onward: number[] = [];
          if (outer && outer !== fn) {
            for (const pos of positions) {
              const arg = n.arguments[pos];
              if (!arg || !ts.isIdentifier(arg)) continue;
              const i = outer.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === arg.text);
              if (i >= 0) onward.push(i);
            }
          }
          writers.push(writerOf(file, n, `${name}()`, new Set(outer && outerFollowable ? paramNames(outer, onward) : []), closed, positions));
          if (outer && onward.length > 0) addForwarder(outer, onward);
        }
        ts.forEachChild(n, visitCalls);
      };
      visitCalls(src);
    }
  }
  // A forwarding helper used other than by a direct call (passed as a
  // callback, aliased, called as a method) has calls the census cannot see.
  const visitRefs = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && forwarders.has(n.text)) {
      const parent = n.parent;
      const directCall = ts.isCallExpression(parent) && parent.expression === n;
      // console.log's `log` is a property name, not the helper; this.log is.
      const otherProperty =
        ts.isPropertyAccessExpression(parent) && parent.name === n && parent.expression.kind !== ts.SyntaxKind.ThisKeyword;
      const ownName = (isFn(parent) || ts.isVariableDeclaration(parent)) && (parent as { name?: ts.Node }).name === n;
      if (!directCall && !ownName && !otherProperty) unfollowable.push(`helper used as a value: ${parent.getText().slice(0, 80)}`);
    }
    ts.forEachChild(n, visitRefs);
  };
  visitRefs(src);
  return { writers, unfollowable };
}

function git(args: string[]): string[] {
  return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8" }).split("\n").filter(Boolean);
}

/** The messaging surface, derived from the checkout by git. */
export function surfaceFiles(): string[] {
  const inDirs = git(["ls-files", "--", ...SURFACE_DIRS.flatMap((d) => [`${d}/*.ts`, `${d}/*.tsx`])]);
  let importers: string[] = [];
  try {
    importers = git(["grep", "-lE", SURFACE_IMPORT_RE, "--", "app/*.ts", "app/*.tsx", "lib/*.ts", "lib/*.tsx", "components/*.ts", "components/*.tsx"]);
  } catch (err) {
    // git grep exits 1 when nothing matches; anything else is a real failure.
    if ((err as { status?: number }).status !== 1) throw err;
  }
  return [...new Set([...inDirs, ...importers])].filter((f) => !/\.(test|spec)\.tsx?$/.test(f)).sort();
}

export const CLOSED_RESULT_SOURCE = "lib/email/send-appointment.ts";

/**
 * The exported functions of CLOSED_RESULT_SOURCE declared to return
 * Promise<EmailSendResult>, read from the source. The compiler holds every one
 * of their returns to that type, whose failure `error` is EmailSendFailure.
 */
export function closedResultFunctions(source = readFileSync(path.join(process.cwd(), CLOSED_RESULT_SOURCE), "utf8")): Set<string> {
  const src = ts.createSourceFile(CLOSED_RESULT_SOURCE, source, ts.ScriptTarget.Latest, true);
  const out = new Set<string>();
  for (const st of src.statements) {
    if (
      ts.isFunctionDeclaration(st) &&
      st.name &&
      ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      st.type?.getText().replace(/\s+/g, "") === "Promise<EmailSendResult>"
    ) {
      out.add(st.name.text);
    }
  }
  return out;
}

export function censusOf(files: readonly string[], closed: ReadonlySet<string> = closedResultFunctions()): Map<string, FileCensus> {
  const out = new Map<string, FileCensus>();
  for (const file of files) {
    const census = analyzeSource(file, readFileSync(path.join(process.cwd(), file), "utf8"), closed);
    if (census.writers.length > 0 || census.unfollowable.length > 0) out.set(file, census);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The #1076 minimum-necessary rules, applied to what a writer can write.
// ---------------------------------------------------------------------------

// Words that name a destination, a credential or message content. A name is
// split into words (camelCase and snake_case), so "client_email", "manageUrl"
// and "toMasked" are caught, while "emailType" and "emailFingerprint" are about
// the address rather than the address itself.
const SENSITIVE_WORDS = new Set([
  "phone", "mobile", "msisdn", "email", "recipient", "address", "destination",
  "token", "url", "uri", "link", "href", "secret", "password", "body",
]);
const QUALIFIER_WORDS = new Set([
  "type", "kind", "status", "state", "attempt", "attempts", "count", "sent", "send", "failed",
  "configured", "enabled", "outcome", "reason", "code", "verified", "present", "missing",
  "length", "shape", "class", "category", "source", "fingerprint", "hash", "hashed", "for", "log",
]);
// "to" and "from" are words of ordinary names (toLowerCase, fromStatus), so
// they count only alone or beside a word that makes them the number itself.
const ENDPOINT_WORDS = new Set(["to", "from"]);
const ENDPOINT_FORMS = new Set(["masked", "raw", "number", "e164", "digits", "last4"]);

export function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function isSensitiveName(name: string): boolean {
  const words = wordsOf(name);
  if (words.some((w) => ENDPOINT_WORDS.has(w))) {
    if (words.length === 1 || words.some((w) => ENDPOINT_FORMS.has(w))) return true;
  }
  if (!words.some((w) => SENSITIVE_WORDS.has(w))) return false;
  return !words.some((w) => QUALIFIER_WORDS.has(w));
}

const LINK_RE = /\bhttps?:\/\/|\bwww\./i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const TOKEN_PATH_RE = /\/(?:manage|intake|cancel|reschedule|invitation|portal\/verify|waitlist)\/[A-Za-z0-9._~%-]{6,}/i;
const PHONE_RE = /\+?\d[\d\s().-]{8,}\d/;
// A masked number still discloses digits ("+1***99"): #1076 bans the form.
const MASKED_PHONE_RE = /\d\*{2,}\d|\+\d*\*{2,}/;

/** What a written literal must never be, or null when it is clean. */
export function literalViolation(text: string): string | null {
  if (LINK_RE.test(text)) return "a link";
  if (EMAIL_RE.test(text)) return "an email address";
  if (TOKEN_PATH_RE.test(text)) return "a token-bearing path";
  if (PHONE_RE.test(text)) return "a phone number";
  if (MASKED_PHONE_RE.test(text)) return "a masked phone number";
  return null;
}

/** "file | via | label": how a census entry is named. */
export function keyOf(w: Pick<Writer, "file" | "via" | "label">): string {
  return `${w.file} | ${w.via} | ${w.label}`;
}
