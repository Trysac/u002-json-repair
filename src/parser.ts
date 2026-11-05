import { JsonRepairError } from "./errors.js";
import { excerpt, isJsonSpace } from "./text.js";
import type { Fix, FixKind } from "./types.js";

type State = "value" | "afterValue" | "key" | "colon" | "done";

interface ArrayFrame {
  readonly kind: "array";
  readonly items: unknown[];
  commaOffset: number;
}

interface ObjectFrame {
  readonly kind: "object";
  readonly members: Record<string, unknown>;
  key: string;
  keyOffset: number;
  commaOffset: number;
}

type Frame = ArrayFrame | ObjectFrame;

interface StringResult {
  readonly value: string;
  readonly terminated: boolean;
  readonly truncatedEscape: boolean;
}

/** Result of a tolerant parse: the value and every fix, sorted by offset. */
export interface ParseOutcome {
  readonly value: unknown;
  readonly fixes: Fix[];
}

const STRICT_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const LENIENT_NUMBER = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const HEX_PREFIX = /^[0-9a-fA-F]*$/;
const KEY_DELIMITERS = ":,{}[]\"'/";

const SIMPLE_ESCAPES = new Map<string, string>([
  ['"', '"'],
  ["\\", "\\"],
  ["/", "/"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);

const JSON_LITERALS = new Map<string, boolean | null>([
  ["true", true],
  ["false", false],
  ["null", null],
]);

const PYTHON_LITERALS = new Map<string, boolean | null>([
  ["True", true],
  ["False", false],
  ["None", null],
]);

const KNOWN_WORDS = new Set([
  "true",
  "false",
  "null",
  "True",
  "False",
  "None",
  "NaN",
  "Infinity",
]);

function unrepairable(message: string, offset: number): JsonRepairError {
  return new JsonRepairError("UNREPAIRABLE", message, offset);
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isIdentCode(code: number): boolean {
  return (
    isDigit(code) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code === 0x24
  );
}

function isIdentStart(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return isIdentCode(code) && !isDigit(code);
}

function isNumberStart(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return isDigit(code) || code === 0x2b || code === 0x2d || code === 0x2e;
}

function isNumberCode(code: number): boolean {
  return isNumberStart(String.fromCharCode(code)) || code === 0x65 || code === 0x45;
}

function isFenceInfoCode(code: number): boolean {
  return isIdentCode(code) || code === 0x2d || code === 0x2b;
}

function isKeyBoundary(ch: string): boolean {
  return isJsonSpace(ch.charCodeAt(0)) || KEY_DELIMITERS.includes(ch);
}

/**
 * Normalizes a number token to strict RFC 8259 syntax.
 *
 * @returns The strict form (equal to `token` when it was already valid) or
 * `null` when the token cannot be a number.
 */
function normalizeNumber(token: string): string | null {
  if (STRICT_NUMBER.test(token)) {
    return token;
  }
  const match = LENIENT_NUMBER.exec(token);
  if (match === null) {
    return null;
  }
  const [, sign = "", rawInt = "", rawFrac = "", exponent] = match;
  if (rawInt === "" && rawFrac === "") {
    return null;
  }
  const int = rawInt.replace(/^0+(?=\d)/, "") || "0";
  const negative = sign === "-" ? "-" : "";
  const frac = rawFrac === "" ? "" : `.${rawFrac}`;
  const exp = exponent === undefined ? "" : `e${exponent}`;
  return `${negative}${int}${frac}${exp}`;
}

class Parser {
  private pos = 0;
  private state: State = "value";
  private result: unknown;
  private readonly stack: Frame[] = [];
  private readonly fixes: Fix[] = [];
  private readonly anchor = /[{[]|```/g;
  private readonly input: string;
  private readonly len: number;
  private readonly maxDepth: number;
  private readonly allowTruncation: boolean;

  constructor(input: string, maxDepth: number, allowTruncation: boolean) {
    this.input = input;
    this.len = input.length;
    this.maxDepth = maxDepth;
    this.allowTruncation = allowTruncation;
  }

  run(): ParseOutcome {
    this.skipLeading();
    while (this.state !== "done") {
      this.skipTrivia();
      if (this.pos >= this.len) {
        this.finishAtEnd();
      } else {
        this.step();
      }
    }
    this.skipTrailing();
    this.fixes.sort((a, b) => a.offset - b.offset);
    return { value: this.result, fixes: this.fixes };
  }

  private addFix(kind: FixKind, offset: number, detail: string): void {
    this.fixes.push({ kind, offset, detail });
  }

  private requireTruncation(): void {
    if (!this.allowTruncation) {
      throw unrepairable("input is truncated and truncation is disabled", this.len);
    }
  }

  private requireFrame(): Frame {
    const frame = this.stack[this.stack.length - 1];
    if (frame === undefined) {
      throw unrepairable("internal parser state error", this.pos);
    }
    return frame;
  }

  private requireObject(): ObjectFrame {
    const frame = this.requireFrame();
    if (frame.kind !== "object") {
      throw unrepairable("internal parser state error", this.pos);
    }
    return frame;
  }

  private skipTrivia(): void {
    while (this.pos < this.len) {
      const code = this.input.charCodeAt(this.pos);
      const next = this.input.charAt(this.pos + 1);
      if (isJsonSpace(code)) {
        this.pos++;
      } else if (code === 0x2f && next === "/") {
        this.skipComment("line comment", "\n", 0);
      } else if (code === 0x2f && next === "*") {
        this.skipComment("block comment", "*/", 2);
      } else {
        return;
      }
    }
  }

  private skipComment(detail: string, end: string, endLength: number): void {
    const index = this.input.indexOf(end, this.pos + 2);
    this.addFix("strip", this.pos, detail);
    this.pos = index === -1 ? this.len : index + endLength;
  }

  private skipFenceMarker(): void {
    this.pos += 3;
    while (
      this.pos < this.len &&
      isFenceInfoCode(this.input.charCodeAt(this.pos))
    ) {
      this.pos++;
    }
  }

  private nextAnchor(from: number): number {
    this.anchor.lastIndex = from;
    const match = this.anchor.exec(this.input);
    return match === null ? -1 : match.index;
  }

  private startsValue(): boolean {
    const ch = this.input.charAt(this.pos);
    if (ch === "{" || ch === "[" || ch === '"' || ch === "'") {
      return true;
    }
    if (isNumberStart(ch)) {
      return true;
    }
    if (!isIdentStart(ch)) {
      return false;
    }
    let end = this.pos + 1;
    while (end < this.len && isIdentCode(this.input.charCodeAt(end))) {
      end++;
    }
    return KNOWN_WORDS.has(this.input.slice(this.pos, end));
  }

  private skipLeading(): void {
    for (;;) {
      this.skipTrivia();
      if (this.pos >= this.len) {
        throw unrepairable("no JSON value found", this.pos);
      }
      if (this.input.startsWith("```", this.pos)) {
        this.addFix("strip", this.pos, "code fence");
        this.skipFenceMarker();
      } else if (this.startsValue()) {
        return;
      } else {
        const next = this.nextAnchor(this.pos + 1);
        if (next === -1) {
          throw unrepairable("no JSON value found", this.pos);
        }
        this.addFix("strip", this.pos, "prose");
        this.pos = next;
      }
    }
  }

  private skipTrailing(): void {
    for (;;) {
      this.skipTrivia();
      if (this.pos >= this.len) {
        return;
      }
      if (this.input.startsWith("```", this.pos)) {
        this.addFix("strip", this.pos, "code fence");
        this.skipFenceMarker();
      } else {
        this.addFix("strip", this.pos, "prose");
        this.pos = this.len;
      }
    }
  }

  private step(): void {
    const ch = this.input.charAt(this.pos);
    if (this.state === "value") {
      this.stepValue(ch);
    } else if (this.state === "colon") {
      this.stepColon(ch);
    } else if (this.state === "afterValue") {
      this.stepAfterValue(ch, this.requireFrame());
    } else {
      this.stepKey(ch, this.requireObject());
    }
  }

  private stepValue(ch: string): void {
    const frame = this.stack[this.stack.length - 1];
    if (ch === "]" && frame?.kind === "array") {
      if (frame.commaOffset >= 0) {
        this.addFix("comma", frame.commaOffset, "trailing comma removed");
      }
      this.pos++;
      this.closeFrame();
      return;
    }
    this.parseValue(ch);
  }

  private stepColon(ch: string): void {
    if (ch !== ":") {
      throw unrepairable("expected ':' after object key", this.pos);
    }
    this.pos++;
    this.state = "value";
  }

  private stepAfterValue(ch: string, frame: Frame): void {
    const isArray = frame.kind === "array";
    if (ch === ",") {
      frame.commaOffset = this.pos;
      this.pos++;
      this.state = isArray ? "value" : "key";
      return;
    }
    if (ch === (isArray ? "]" : "}")) {
      this.pos++;
      this.closeFrame();
      return;
    }
    this.addFix("comma", this.pos, "missing comma inserted");
    this.state = isArray ? "value" : "key";
  }

  private stepKey(ch: string, frame: ObjectFrame): void {
    if (ch === "}") {
      if (frame.commaOffset >= 0) {
        this.addFix("comma", frame.commaOffset, "trailing comma removed");
      }
      this.pos++;
      this.closeFrame();
      return;
    }
    const start = this.pos;
    if (ch === '"' || ch === "'") {
      const parsed = this.readString();
      if (!parsed.terminated) {
        this.requireTruncation();
        this.addFix("drop-dangling-key", start, "dangling key dropped");
        frame.commaOffset = -1;
        return;
      }
      this.setKey(frame, parsed.value, start);
      return;
    }
    const key = this.readUnquotedKey();
    this.addFix("quote", start, "unquoted key quoted");
    this.setKey(frame, key, start);
  }

  private setKey(frame: ObjectFrame, key: string, offset: number): void {
    frame.key = key;
    frame.keyOffset = offset;
    frame.commaOffset = -1;
    this.state = "colon";
  }

  private readUnquotedKey(): string {
    const start = this.pos;
    let end = start;
    while (end < this.len && !isKeyBoundary(this.input.charAt(end))) {
      end++;
    }
    if (end === start) {
      throw unrepairable("expected an object key", start);
    }
    this.pos = end;
    return this.input.slice(start, end);
  }

  private parseValue(ch: string): void {
    if (ch === "{") {
      this.open("object");
    } else if (ch === "[") {
      this.open("array");
    } else if (ch === '"' || ch === "'") {
      this.parseStringValue();
    } else if (isIdentStart(ch)) {
      this.parseLiteral(false);
    } else if (
      (ch === "-" || ch === "+") &&
      isIdentStart(this.input.charAt(this.pos + 1))
    ) {
      this.parseLiteral(true);
    } else if (isNumberStart(ch)) {
      this.parseNumber();
    } else {
      throw unrepairable(
        `unexpected character ${JSON.stringify(ch)}`,
        this.pos,
      );
    }
  }

  private open(kind: "array" | "object"): void {
    if (this.stack.length >= this.maxDepth) {
      throw new JsonRepairError(
        "MAX_DEPTH",
        `nesting exceeds maxDepth ${this.maxDepth}`,
        this.pos,
      );
    }
    if (kind === "array") {
      this.stack.push({ kind: "array", items: [], commaOffset: -1 });
    } else {
      this.stack.push({
        kind: "object",
        members: {},
        key: "",
        keyOffset: -1,
        commaOffset: -1,
      });
    }
    this.pos++;
    this.state = kind === "array" ? "value" : "key";
  }

  private closeFrame(): void {
    const frame = this.requireFrame();
    this.stack.pop();
    this.completeValue(frame.kind === "array" ? frame.items : frame.members);
  }

  private completeValue(value: unknown): void {
    const frame = this.stack[this.stack.length - 1];
    if (frame === undefined) {
      this.result = value;
      this.state = "done";
      return;
    }
    if (frame.kind === "array") {
      frame.items.push(value);
    } else {
      if (Object.hasOwn(frame.members, frame.key)) {
        const shown = excerpt(frame.key);
        this.addFix(
          "duplicate-key",
          frame.keyOffset,
          `duplicate key "${shown}"; last value kept`,
        );
      }
      Object.defineProperty(frame.members, frame.key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    frame.commaOffset = -1;
    this.state = "afterValue";
  }

  private finishAtEnd(): void {
    const top = this.stack[this.stack.length - 1];
    if (top === undefined) {
      throw unrepairable("no JSON value found", this.pos);
    }
    this.requireTruncation();
    if (top.kind === "object") {
      if (this.state === "colon" || this.state === "value") {
        this.addFix("drop-dangling-key", top.keyOffset, "dangling key dropped");
      } else if (top.commaOffset >= 0) {
        this.addFix("comma", top.commaOffset, "trailing comma removed");
      }
    } else if (this.state === "value" && top.commaOffset >= 0) {
      this.addFix("comma", top.commaOffset, "trailing comma removed");
    }
    while (this.stack.length > 0) {
      const frame = this.requireFrame();
      const what = frame.kind === "array" ? "array" : "object";
      this.addFix("close", this.len, `unterminated ${what} closed`);
      this.closeFrame();
    }
  }

  private parseStringValue(): void {
    const parsed = this.readString();
    if (!parsed.terminated) {
      this.requireTruncation();
      const note = parsed.truncatedEscape ? "; incomplete escape dropped" : "";
      this.addFix("close", this.len, `unterminated string closed${note}`);
    }
    this.completeValue(parsed.value);
  }

  private readString(): StringResult {
    const quote = this.input.charAt(this.pos);
    if (quote === "'") {
      this.addFix("quote", this.pos, "single-quoted string converted");
    }
    this.pos++;
    let out = "";
    let chunk = this.pos;
    let truncatedEscape = false;
    while (this.pos < this.len) {
      const ch = this.input.charAt(this.pos);
      if (ch === quote) {
        out += this.input.slice(chunk, this.pos);
        this.pos++;
        return { value: out, terminated: true, truncatedEscape };
      }
      if (ch === "\\") {
        out += this.input.slice(chunk, this.pos);
        const escaped = this.readEscape(quote);
        if (escaped === null) {
          truncatedEscape = true;
        } else {
          out += escaped;
        }
        chunk = this.pos;
      } else {
        const code = ch.charCodeAt(0);
        if (code < 0x20) {
          const hex = code.toString(16).toUpperCase().padStart(4, "0");
          this.addFix(
            "escape-control-char",
            this.pos,
            `raw control character U+${hex} escaped`,
          );
        }
        this.pos++;
      }
    }
    out += this.input.slice(chunk, this.pos);
    return { value: out, terminated: false, truncatedEscape };
  }

  private readEscape(quote: string): string | null {
    const start = this.pos;
    if (start + 1 >= this.len) {
      this.pos = this.len;
      return null;
    }
    const next = this.input.charAt(start + 1);
    const simple = SIMPLE_ESCAPES.get(next);
    if (simple !== undefined) {
      this.pos = start + 2;
      return simple;
    }
    if (next === "'" && quote === "'") {
      this.pos = start + 2;
      return "'";
    }
    if (next === "u") {
      const hex = this.input.slice(start + 2, start + 6);
      if (HEX4.test(hex)) {
        this.pos = start + 6;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      if (hex.length < 4 && HEX_PREFIX.test(hex)) {
        this.pos = this.len;
        return null;
      }
    }
    const shown = excerpt(this.input.slice(start, start + 6));
    throw unrepairable(`invalid escape sequence "${shown}"`, start);
  }

  private parseLiteral(signed: boolean): void {
    const start = this.pos;
    const sign = signed ? this.input.charAt(start) : "";
    if (signed) {
      this.pos++;
    }
    const wordStart = this.pos;
    while (this.pos < this.len && isIdentCode(this.input.charCodeAt(this.pos))) {
      this.pos++;
    }
    const word = this.input.slice(wordStart, this.pos);
    if (word === "NaN" || word === "Infinity") {
      this.addFix(
        "non-finite-literal",
        start,
        `${sign}${word} replaced by null`,
      );
      this.completeValue(null);
    } else if (!signed && JSON_LITERALS.has(word)) {
      this.completeValue(JSON_LITERALS.get(word));
    } else if (!signed && PYTHON_LITERALS.has(word)) {
      this.addFix("python-literal", start, `${word} converted to JSON`);
      this.completeValue(PYTHON_LITERALS.get(word));
    } else {
      throw unrepairable(`unknown literal "${excerpt(sign + word)}"`, start);
    }
  }

  private parseNumber(): void {
    const start = this.pos;
    let end = start;
    while (end < this.len && isNumberCode(this.input.charCodeAt(end))) {
      end++;
    }
    const token = this.input.slice(start, end);
    const shown = excerpt(token);
    const normalized = normalizeNumber(token);
    if (normalized === null) {
      if (end < this.len) {
        throw unrepairable(`invalid number "${shown}"`, start);
      }
      this.requireTruncation();
      this.addFix("number", start, `incomplete number "${shown}" dropped`);
      this.pos = end;
      return;
    }
    this.pos = end;
    const value = Number(normalized);
    if (!Number.isFinite(value)) {
      this.addFix(
        "non-finite-literal",
        start,
        `number "${shown}" out of range replaced by null`,
      );
      this.completeValue(null);
      return;
    }
    if (normalized !== token) {
      this.addFix(
        "number",
        start,
        `number "${shown}" normalized to "${excerpt(normalized)}"`,
      );
    }
    this.completeValue(value);
  }
}

/**
 * Runs the tolerant single-pass parser.
 *
 * @param input - Text to parse; length limits are enforced by the caller.
 * @param maxDepth - Maximum nesting depth.
 * @param allowTruncation - Whether input may be closed at its end.
 * @returns The parsed value and every fix, sorted by offset.
 * @throws {JsonRepairError} When the input cannot be repaired.
 */
export function parse(
  input: string,
  maxDepth: number,
  allowTruncation: boolean,
): ParseOutcome {
  return new Parser(input, maxDepth, allowTruncation).run();
}
