/**
 * Tolerant JSON repair for text produced by language models.
 *
 * {@link repairJson} parses truncated or malformed JSON in a single pass with
 * an explicit stack and returns the value, the repaired text and an
 * offset-annotated list of every fix that was applied.
 *
 * @packageDocumentation
 */

/** Category of a repair applied to the input. */
export type FixKind =
  | "strip"
  | "comma"
  | "quote"
  | "python-literal"
  | "non-finite-literal"
  | "number"
  | "escape-control-char"
  | "close"
  | "drop-dangling-key"
  | "duplicate-key";

/** Stable machine-readable code carried by {@link JsonRepairError}. */
export type JsonRepairErrorCode =
  | "INPUT_TOO_LARGE"
  | "EMPTY_INPUT"
  | "UNREPAIRABLE"
  | "MAX_DEPTH"
  | "TOO_MANY_FIXES";

/** One repair applied to the input. */
export interface Fix {
  /** Category of the repair. */
  readonly kind: FixKind;
  /** UTF-16 index into the original input where the repair applies. */
  readonly offset: number;
  /** Short description such as `bom`, `prose` or `array`. */
  readonly detail: string;
}

/** Outcome of a successful repair. */
export interface RepairResult {
  /** The repaired value. */
  readonly value: unknown;
  /** The input itself when no fix was needed, otherwise compact JSON. */
  readonly text: string;
  /** Every fix, sorted by offset. */
  readonly fixes: Fix[];
}

/** Limits and switches for {@link repairJson}. */
export interface RepairOptions {
  /** Maximum input length in UTF-16 units. Default 1_000_000. */
  maxLength?: number;
  /** Maximum container nesting. Default 512. */
  maxDepth?: number;
  /** Maximum number of fixes. Default 10_000. */
  maxFixes?: number;
  /** Complete input that is cut off mid-value. Default true. */
  allowTruncation?: boolean;
}

/** Error raised for every input that cannot be repaired within the limits. */
export class JsonRepairError extends Error {
  /** Stable machine-readable error code. */
  readonly code: JsonRepairErrorCode;
  /** UTF-16 offset in the input that the error refers to. */
  readonly offset: number;

  constructor(code: JsonRepairErrorCode, message: string, offset: number) {
    super(message);
    this.name = "JsonRepairError";
    this.code = code;
    this.offset = offset;
  }
}

interface Limits {
  readonly maxLength: number;
  readonly maxDepth: number;
  readonly maxFixes: number;
  readonly allowTruncation: boolean;
}

interface ArrayFrame {
  readonly array: true;
  readonly items: unknown[];
}

interface ObjectFrame {
  readonly array: false;
  readonly obj: Record<string, unknown>;
  key: string;
  keyStart: number;
}

type Frame = ArrayFrame | ObjectFrame;

type State = "value" | "element" | "after";

interface Scalar {
  readonly value: unknown;
  readonly end: number;
}

interface StringToken {
  readonly value: string;
  readonly end: number;
  readonly complete: boolean;
}

interface Escape {
  readonly text: string;
  readonly width: number;
}

interface Literal {
  readonly value: unknown;
  readonly kind: FixKind | null;
}

const DEFAULT_MAX_LENGTH = 1_000_000;
const DEFAULT_MAX_DEPTH = 512;
const DEFAULT_MAX_FIXES = 10_000;
const SNIPPET_LENGTH = 40;

const DEFAULT_LIMITS: Limits = {
  maxLength: DEFAULT_MAX_LENGTH,
  maxDepth: DEFAULT_MAX_DEPTH,
  maxFixes: DEFAULT_MAX_FIXES,
  allowTruncation: true,
};

const STRICT_NUM = /^-?(?:0|[1-9][0-9]*)(?:[.][0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const INTEGER = /^[+-]?[0-9]+$/;
const NONZERO_MANTISSA = /^[^eE]*[1-9]/;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const HEX_ANY = /^[0-9a-fA-F]*$/;

const SIMPLE_ESCAPES = new Map<number, number>([
  [34, 34],
  [92, 92],
  [47, 47],
  [98, 8],
  [102, 12],
  [110, 10],
  [114, 13],
  [116, 9],
]);

const LITERALS = new Map<string, Literal>([
  ["true", { value: true, kind: null }],
  ["false", { value: false, kind: null }],
  ["null", { value: null, kind: null }],
  ["True", { value: true, kind: "python-literal" }],
  ["False", { value: false, kind: "python-literal" }],
  ["None", { value: null, kind: "python-literal" }],
  ["NaN", { value: null, kind: "non-finite-literal" }],
  ["Infinity", { value: null, kind: "non-finite-literal" }],
]);

const TRUNCATABLE: readonly (readonly [string, unknown])[] = [
  ["true", true],
  ["false", false],
  ["null", null],
];

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

function isKeyStart(c: number): boolean {
  const upper = c >= 65 && c <= 90;
  const lower = c >= 97 && c <= 122;
  return upper || lower || c === 95 || c === 36 || c >= 128;
}

function isKeyPart(c: number): boolean {
  return isKeyStart(c) || isDigit(c);
}

function isFenceLang(c: number): boolean {
  return isKeyPart(c) || c === 43 || c === 45 || c === 46;
}

function isLineBreak(c: number): boolean {
  return c === 10 || c === 13;
}

function byOffset(a: Fix, b: Fix): number {
  return a.offset - b.offset;
}

function truncatedLiteral(word: string): readonly [string, unknown] | undefined {
  return TRUNCATABLE.find(([full]) => full.startsWith(word));
}

function snippet(input: string, offset: number): string {
  let text = "";
  const end = Math.min(input.length, offset + SNIPPET_LENGTH);
  for (let i = Math.max(offset, 0); i < end; i += 1) {
    text += input.charCodeAt(i) < 32 ? " " : input.charAt(i);
  }
  return `"${text}"`;
}

function numberLoss(lexeme: string, value: number): string | undefined {
  if (!Number.isFinite(value)) {
    return "out-of-range";
  }
  if (value === 0) {
    if (NONZERO_MANTISSA.test(lexeme)) {
      return "out-of-range";
    }
    return Object.is(value, -0) ? "negative-zero" : undefined;
  }
  if (INTEGER.test(lexeme) && Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    return "precision";
  }
  return undefined;
}

function limitOf(value: unknown, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  const message = `${name} must be a positive safe integer`;
  if (typeof value !== "number") {
    throw new TypeError(message);
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(message);
  }
  return value;
}

function resolveOptions(options: RepairOptions | undefined): Limits {
  if (options === undefined) {
    return DEFAULT_LIMITS;
  }
  if (typeof options !== "object" || options === null) {
    throw new TypeError("options must be an object");
  }
  const allow = options.allowTruncation;
  if (allow !== undefined && typeof allow !== "boolean") {
    throw new TypeError("allowTruncation must be a boolean");
  }
  return {
    maxLength: limitOf(options.maxLength, DEFAULT_MAX_LENGTH, "maxLength"),
    maxDepth: limitOf(options.maxDepth, DEFAULT_MAX_DEPTH, "maxDepth"),
    maxFixes: limitOf(options.maxFixes, DEFAULT_MAX_FIXES, "maxFixes"),
    allowTruncation: allow ?? true,
  };
}

class Repairer {
  private readonly input: string;
  private readonly limits: Limits;
  private readonly n: number;
  private readonly fixes: Fix[] = [];
  private readonly lossy: Fix[] = [];
  private readonly stack: Frame[] = [];
  private root: unknown;
  private pos = 0;
  private state: State = "value";
  private comma = -1;
  private done = false;

  constructor(input: string, limits: Limits) {
    this.input = input;
    this.limits = limits;
    this.n = input.length;
  }

  run(): RepairResult {
    this.pos = this.skipLeading();
    while (!this.done) {
      if (this.state === "value") {
        this.stepValue();
      } else if (this.state === "element") {
        this.stepElement();
      } else {
        this.stepAfter();
      }
    }
    this.skipTrailing();
    return this.finish();
  }

  private at(i: number): number {
    return this.input.charCodeAt(i);
  }

  private top(): Frame {
    return this.stack[this.stack.length - 1] as Frame;
  }

  private makeFix(kind: FixKind, offset: number, detail: string): Fix {
    return Object.freeze({ kind, offset, detail });
  }

  private addFix(kind: FixKind, offset: number, detail: string): void {
    if (this.fixes.length >= this.limits.maxFixes) {
      throw this.tooMany(offset);
    }
    this.fixes.push(this.makeFix(kind, offset, detail));
  }

  private noteLoss(offset: number, detail: string): void {
    if (this.lossy.length > this.limits.maxFixes) {
      return;
    }
    this.lossy.push(this.makeFix("number", offset, detail));
  }

  private tooMany(offset: number): JsonRepairError {
    const message = `more than ${this.limits.maxFixes} fixes are needed`;
    return new JsonRepairError("TOO_MANY_FIXES", message, offset);
  }

  private unrepairable(offset: number, what: string): JsonRepairError {
    const quoted = snippet(this.input, offset);
    const message = `${what} at offset ${offset}: ${quoted}`;
    return new JsonRepairError("UNREPAIRABLE", message, offset);
  }

  private requireTruncation(): void {
    if (!this.limits.allowTruncation) {
      const message = "input is truncated and allowTruncation is false";
      throw new JsonRepairError("UNREPAIRABLE", message, this.n);
    }
  }

  private skipTrivia(from: number): number {
    let i = from;
    for (;;) {
      const c = this.at(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) {
        i += 1;
      } else if (c === 47 && this.at(i + 1) === 47) {
        i = this.skipLineComment(i);
      } else if (c === 47 && this.at(i + 1) === 42) {
        i = this.skipBlockComment(i);
      } else {
        return i;
      }
    }
  }

  private skipLineComment(start: number): number {
    let end = start + 2;
    while (end < this.n && !isLineBreak(this.at(end))) {
      end += 1;
    }
    this.addFix("strip", start, "comment");
    return end;
  }

  private skipBlockComment(start: number): number {
    const close = this.input.indexOf("*/", start + 2);
    this.addFix("strip", start, "comment");
    return close < 0 ? this.n : close + 2;
  }

  private skipLeading(): number {
    let pos = 0;
    if (this.at(0) === 0xfeff) {
      this.addFix("strip", 0, "bom");
      pos = 1;
    }
    for (;;) {
      pos = this.skipTrivia(pos);
      if (pos >= this.n) {
        throw this.unrepairable(pos, "no JSON value found");
      }
      if (this.input.startsWith("```", pos)) {
        pos = this.stripFence(pos);
      } else if (this.valueStartsAt(pos)) {
        return pos;
      } else {
        const next = this.proseEnd(pos);
        if (next < 0) {
          throw this.unrepairable(pos, "no JSON value found");
        }
        this.addFix("strip", pos, "prose");
        pos = next;
      }
    }
  }

  private stripFence(pos: number): number {
    this.addFix("strip", pos, "fence");
    let end = pos + 3;
    while (isFenceLang(this.at(end))) {
      end += 1;
    }
    const hasLang = end > pos + 3 && isLineBreak(this.at(end));
    return hasLang ? end : pos + 3;
  }

  private proseEnd(from: number): number {
    for (let i = from; i < this.n; i += 1) {
      const c = this.at(i);
      if (c === 123 || c === 91) {
        return i;
      }
      if (c === 96 && this.input.startsWith("```", i)) {
        return i;
      }
    }
    return -1;
  }

  private skipTrailing(): void {
    let pos = this.skipTrivia(this.pos);
    while (pos < this.n) {
      if (this.input.startsWith("```", pos)) {
        this.addFix("strip", pos, "fence");
        pos = this.skipTrivia(pos + 3);
      } else {
        this.addFix("strip", pos, "prose");
        return;
      }
    }
  }

  private wordEnd(pos: number): number {
    let end = pos;
    while (isKeyPart(this.at(end))) {
      end += 1;
    }
    return end;
  }

  private valueStartsAt(pos: number): boolean {
    const c = this.at(pos);
    const structural = c === 123 || c === 91 || c === 34 || c === 39;
    const numeric = isDigit(c) || c === 45 || c === 43 || c === 46;
    if (structural) {
      return true;
    }
    if (numeric) {
      return this.scalarIsValue(pos);
    }
    if (!isKeyStart(c)) {
      return false;
    }
    const end = this.wordEnd(pos);
    const word = this.input.slice(pos, end);
    if (LITERALS.has(word)) {
      return this.scalarIsValue(pos);
    }
    return end === this.n && truncatedLiteral(word) !== undefined;
  }

  /** A leading scalar is a value unless prose introducing a later '{', '[' or fence follows it. */
  private scalarIsValue(pos: number): boolean {
    let e = pos;
    while (e < this.n && !/\s/u.test(this.input.charAt(e))) {
      e += 1;
    }
    while (e < this.n && /\s/u.test(this.input.charAt(e))) {
      e += 1;
    }
    if (e >= this.n || this.input.startsWith("```", e)) {
      return true;
    }
    return this.proseEnd(pos) < 0;
  }

  private stepValue(): void {
    const c = this.at(this.pos);
    if (c === 123 || c === 91) {
      this.open(c === 91);
      return;
    }
    const scalar = this.parseScalar(this.pos);
    this.attach(scalar.value);
    this.pos = scalar.end;
    if (this.stack.length === 0) {
      this.done = true;
    } else {
      this.state = "after";
    }
  }

  private open(isArray: boolean): void {
    const { maxDepth } = this.limits;
    if (this.stack.length >= maxDepth) {
      const message = `nesting exceeds maxDepth of ${maxDepth}`;
      throw new JsonRepairError("MAX_DEPTH", message, this.pos);
    }
    if (isArray) {
      const items: unknown[] = [];
      this.attach(items);
      this.stack.push({ array: true, items });
    } else {
      const obj: Record<string, unknown> = {};
      this.attach(obj);
      const frame: ObjectFrame = {
        array: false,
        obj,
        key: "",
        keyStart: 0,
      };
      this.stack.push(frame);
    }
    this.pos += 1;
    this.comma = -1;
    this.state = "element";
  }

  private attach(value: unknown): void {
    const top = this.stack[this.stack.length - 1];
    if (top === undefined) {
      this.root = value;
      return;
    }
    if (top.array) {
      top.items.push(value);
      return;
    }
    if (Object.hasOwn(top.obj, top.key)) {
      this.addFix("duplicate-key", top.keyStart, "last value kept");
    }
    Object.defineProperty(top.obj, top.key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  private trailingComma(): void {
    if (this.comma >= 0) {
      this.addFix("comma", this.comma, "trailing comma");
      this.comma = -1;
    }
  }

  private closeTop(): void {
    this.stack.pop();
    this.pos += 1;
    if (this.stack.length === 0) {
      this.done = true;
    } else {
      this.state = "after";
    }
  }

  private truncate(comma: number): void {
    this.requireTruncation();
    if (comma >= 0) {
      this.addFix("comma", comma, "trailing comma");
    }
    while (this.stack.length > 0) {
      const frame = this.top();
      this.stack.pop();
      this.addFix("close", this.n, frame.array ? "array" : "object");
    }
    this.pos = this.n;
    this.done = true;
  }

  private dangle(keyStart: number, from: number, to: number): void {
    this.requireTruncation();
    this.fixes.splice(from, to - from);
    this.addFix("drop-dangling-key", keyStart, "key without a value");
    this.truncate(-1);
  }

  private stepElement(): void {
    this.pos = this.skipTrivia(this.pos);
    if (this.pos >= this.n) {
      this.truncate(this.comma);
      return;
    }
    const top = this.top();
    const c = this.at(this.pos);
    if (c === (top.array ? 93 : 125)) {
      this.trailingComma();
      this.closeTop();
    } else if (c === 44) {
      throw this.unrepairable(this.pos, "unexpected comma");
    } else if (top.array) {
      this.state = "value";
    } else {
      this.readKey(top);
    }
  }

  private readKey(frame: ObjectFrame): void {
    const start = this.pos;
    const from = this.fixes.length;
    const c = this.at(start);
    let key: string;
    if (c === 34 || c === 39) {
      const token = this.parseString(start);
      if (!token.complete) {
        this.dangle(start, from, this.fixes.length);
        return;
      }
      key = token.value;
      this.pos = token.end;
    } else if (isKeyStart(c)) {
      const end = this.wordEnd(start);
      key = this.input.slice(start, end);
      this.addFix("quote", start, "unquoted key");
      this.pos = end;
    } else {
      throw this.unrepairable(start, "expected an object key");
    }
    const to = this.fixes.length;
    this.pos = this.skipTrivia(this.pos);
    if (this.pos >= this.n) {
      this.dangle(start, from, to);
      return;
    }
    if (this.at(this.pos) !== 58) {
      throw this.unrepairable(this.pos, "expected a colon");
    }
    this.pos = this.skipTrivia(this.pos + 1);
    if (this.pos >= this.n) {
      this.dangle(start, from, to);
      return;
    }
    frame.key = key;
    frame.keyStart = start;
    this.state = "value";
  }

  private stepAfter(): void {
    const before = this.pos;
    this.pos = this.skipTrivia(before);
    if (this.pos >= this.n) {
      this.truncate(-1);
      return;
    }
    const top = this.top();
    const c = this.at(this.pos);
    if (c === 44) {
      this.comma = this.pos;
      this.pos += 1;
      this.state = "element";
    } else if (c === (top.array ? 93 : 125)) {
      this.closeTop();
    } else if (c === 93 || c === 125) {
      throw this.unrepairable(this.pos, "mismatched closing bracket");
    } else {
      this.insertComma(top, c, this.pos > before);
    }
  }

  private startsElement(top: Frame, c: number): boolean {
    if (top.array) {
      return this.valueStartsAt(this.pos);
    }
    return c === 34 || c === 39 || isKeyStart(c);
  }

  private insertComma(top: Frame, c: number, spaced: boolean): void {
    const tight = c === 34 || c === 39 || c === 123 || c === 91;
    if (!this.startsElement(top, c) || !(spaced || tight)) {
      throw this.unrepairable(this.pos, "expected a comma or bracket");
    }
    this.addFix("comma", this.pos, "missing comma");
    this.comma = -1;
    this.state = "element";
  }

  private parseScalar(pos: number): Scalar {
    const c = this.at(pos);
    if (c === 34 || c === 39) {
      const token = this.parseString(pos);
      if (!token.complete) {
        this.requireTruncation();
        this.addFix("close", this.n, "string");
      }
      return { value: token.value, end: token.end };
    }
    if (isKeyStart(c)) {
      return this.parseWord(pos);
    }
    const signed = c === 45 || c === 43;
    if (signed && this.isInfinityAt(pos + 1)) {
      this.addFix("non-finite-literal", pos, "signed Infinity");
      return { value: null, end: pos + 9 };
    }
    return this.parseNumber(pos);
  }

  private isInfinityAt(pos: number): boolean {
    const startsWord = this.input.startsWith("Infinity", pos);
    return startsWord && !isKeyPart(this.at(pos + 8));
  }

  private parseWord(pos: number): Scalar {
    const end = this.wordEnd(pos);
    const word = this.input.slice(pos, end);
    const literal = LITERALS.get(word);
    if (literal !== undefined) {
      if (literal.kind !== null) {
        this.addFix(literal.kind, pos, word);
      }
      return { value: literal.value, end };
    }
    const partial = end === this.n ? truncatedLiteral(word) : undefined;
    if (partial !== undefined) {
      this.requireTruncation();
      this.addFix("close", this.n, "literal");
      return { value: partial[1], end };
    }
    throw this.unrepairable(pos, "unexpected token");
  }

  private parseNumber(pos: number): Scalar {
    const s = this.input;
    let i = pos;
    if (this.at(i) === 43 || this.at(i) === 45) {
      i += 1;
    }
    const intStart = i;
    while (isDigit(this.at(i))) {
      i += 1;
    }
    let digits = i - intStart;
    if (this.at(i) === 46) {
      i += 1;
      const fracStart = i;
      while (isDigit(this.at(i))) {
        i += 1;
      }
      digits += i - fracStart;
    }
    if (digits === 0) {
      throw this.unrepairable(pos, "invalid number");
    }
    if (this.at(i) === 101 || this.at(i) === 69) {
      i = this.exponentEnd(pos, i);
    }
    const next = this.at(i);
    if (isKeyPart(next) || next === 46) {
      throw this.unrepairable(i, "unexpected character after number");
    }
    const lexeme = s.slice(pos, i);
    if (!STRICT_NUM.test(lexeme)) {
      this.addFix("number", pos, "normalized");
    }
    const value = Number(lexeme);
    const loss = numberLoss(lexeme, value);
    if (loss !== undefined) {
      this.noteLoss(pos, loss);
    }
    return { value, end: i };
  }

  private exponentEnd(pos: number, marker: number): number {
    let j = marker + 1;
    if (this.at(j) === 43 || this.at(j) === 45) {
      j += 1;
    }
    const digitsStart = j;
    while (isDigit(this.at(j))) {
      j += 1;
    }
    if (j === digitsStart) {
      throw this.unrepairable(pos, "incomplete exponent");
    }
    return j;
  }

  private parseString(start: number): StringToken {
    const s = this.input;
    const quote = this.at(start);
    if (quote === 39) {
      this.addFix("quote", start, "single-quoted string");
    }
    let out = "";
    let chunk = start + 1;
    let i = chunk;
    while (i < this.n) {
      const c = this.at(i);
      if (c === quote) {
        const value = out + s.slice(chunk, i);
        return { value, end: i + 1, complete: true };
      }
      if (c === 92) {
        out += s.slice(chunk, i);
        const esc = this.readEscape(i, quote);
        if (esc === undefined) {
          return { value: out, end: this.n, complete: false };
        }
        out += esc.text;
        i += esc.width;
        chunk = i;
      } else {
        if (c < 32) {
          this.addFix("escape-control-char", i, "raw control character");
        }
        i += 1;
      }
    }
    const value = out + s.slice(chunk);
    return { value, end: this.n, complete: false };
  }

  private readEscape(i: number, quote: number): Escape | undefined {
    if (i + 1 >= this.n) {
      return undefined;
    }
    const e = this.at(i + 1);
    const simple = SIMPLE_ESCAPES.get(e);
    if (simple !== undefined) {
      return { text: String.fromCharCode(simple), width: 2 };
    }
    if (e === 39) {
      if (quote === 34) {
        this.addFix("quote", i, "escaped single quote");
      }
      return { text: "'", width: 2 };
    }
    if (e === 117) {
      return this.readUnicode(i);
    }
    throw this.unrepairable(i, "invalid escape sequence");
  }

  private readUnicode(i: number): Escape | undefined {
    const hex = this.input.slice(i + 2, i + 6);
    if (HEX4.test(hex)) {
      const text = String.fromCharCode(Number.parseInt(hex, 16));
      return { text, width: 6 };
    }
    if (hex.length < 4 && HEX_ANY.test(hex)) {
      return undefined;
    }
    throw this.unrepairable(i, "invalid unicode escape");
  }

  private serialize(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch {
      const message = "value is nested too deeply to serialise";
      throw new JsonRepairError("MAX_DEPTH", message, 0);
    }
  }

  private finish(): RepairResult {
    const value = this.root;
    if (this.fixes.length === 0) {
      return { value, text: this.input, fixes: [] };
    }
    const all = [...this.fixes, ...this.lossy];
    const max = this.limits.maxFixes;
    if (all.length > max) {
      throw this.tooMany((all[max] as Fix).offset);
    }
    all.sort(byOffset);
    return { value, text: this.serialize(value), fixes: all };
  }
}

/**
 * Repairs truncated or malformed JSON and reports every fix.
 *
 * The text is parsed in one pass with an explicit stack, so nesting is bounded
 * by `maxDepth` and never by the call stack. When no fix is needed `text` is
 * the input itself; otherwise it is the compact serialisation of `value`.
 *
 * @param input - The text to repair.
 * @param options - Optional limits; see {@link RepairOptions}.
 * @returns The value, the repaired text and the fixes sorted by offset.
 * @throws {JsonRepairError} When the input is too large, empty, unrepairable,
 * too deep or needs more than `maxFixes` fixes.
 * @throws {TypeError} When an option or the input has the wrong type.
 */
export function repairJson(input: string, options?: RepairOptions): RepairResult {
  const limits = resolveOptions(options);
  if (typeof input !== "string") {
    throw new TypeError("input must be a string");
  }
  if (input.length > limits.maxLength) {
    const message = `input has ${input.length} UTF-16 units; maxLength is ${limits.maxLength}`;
    throw new JsonRepairError("INPUT_TOO_LARGE", message, 0);
  }
  if (input.trim() === "") {
    throw new JsonRepairError("EMPTY_INPUT", "input is empty", 0);
  }
  return new Repairer(input, limits).run();
}

/**
 * Like {@link repairJson} but returns `null` instead of throwing a
 * {@link JsonRepairError}. Invalid options still throw a `TypeError`.
 *
 * @param input - The text to repair.
 * @param options - Optional limits; see {@link RepairOptions}.
 * @returns The repair result, or `null` when the input cannot be repaired.
 */
export function tryRepairJson(input: string, options?: RepairOptions): RepairResult | null {
  try {
    return repairJson(input, options);
  } catch (error) {
    if (error instanceof JsonRepairError) {
      return null;
    }
    throw error;
  }
}
