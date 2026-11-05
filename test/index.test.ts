import { describe, expect, it, vi } from "vitest";
import { JsonRepairError, repairJson, tryRepairJson } from "../src/index.js";

type Result = ReturnType<typeof repairJson>;

function kinds(result: Result): string[] {
  return result.fixes.map((fix) => fix.kind);
}

function details(result: Result): string[] {
  return result.fixes.map((fix) => fix.detail);
}

function failure(run: () => unknown): JsonRepairError {
  try {
    run();
  } catch (error) {
    if (error instanceof JsonRepairError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a JsonRepairError");
}

const VALID: readonly string[] = [
  ' \n{"a": [1, 2.5e3, -0, "x\\n", true, false, null], "b": {}}\t\r\n',
  "[]",
  "[ ]",
  "{}",
  '"s"',
  "123",
  "-1.5E+2",
  "null",
  "true",
  '[[], [[1]], {"a": []}]',
  '"\\ud800"',
  '"\\ud83d\\ude00"',
  '{"a": {"b": [[], [[[]]]]}}',
];

const BROKEN: readonly string[] = [
  '{"a":1, "b": [1, 2',
  "{'a': True, b: NaN, // c\n }",
  '{"a":1,"a":2}',
  '{"a": 1, "b": ',
  'Sure!\n```json\n{"a": 1,}\n```\nDone.',
  "[1 2 'x' /* c */]",
  "[1., .5, +1, 007, 1e999, NaN]",
  '{"a": "hel',
  '["ab\\',
  '{"a": [{"b": [1, {"c": "x',
  '"tab\there"',
  "{a: -Infinity, b: None}",
  "[1, -",
];

describe("valid input", () => {
  it.each(VALID)("returns %j untouched", (input) => {
    const result = repairJson(input);
    expect(result.text).toBe(input);
    expect(result.fixes).toEqual([]);
    expect(result.value).toEqual(JSON.parse(input));
  });

  it("decodes every simple escape", () => {
    const input = String.raw`"\u0041\n\t\/\b\f\r\\\""`;
    const result = repairJson(input);
    expect(result.value).toBe('A\n\t/\b\f\r\\"');
    expect(result.fixes).toEqual([]);
    expect(result.text).toBe(input);
  });

  it("decodes surrogate pairs written as escapes", () => {
    expect(repairJson('"\\ud83d\\ude00"').value).toBe("\u{1F600}");
  });

  it("keeps lone surrogates as-is", () => {
    const input = `"${String.fromCharCode(0xd800)}"`;
    const result = repairJson(input);
    expect(result.value).toBe(String.fromCharCode(0xd800));
    expect(result.fixes).toEqual([]);
    expect(result.text).toBe(input);
  });

  it("keeps __proto__ and constructor as plain own properties", () => {
    const result = repairJson('{"__proto__": {"x": 1}, "constructor": 2}');
    const value = result.value as Record<string, unknown>;
    const proto = Object.getOwnPropertyDescriptor(value, "__proto__");
    const ctor = Object.getOwnPropertyDescriptor(value, "constructor");
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect(proto?.value).toEqual({ x: 1 });
    expect(ctor?.value).toBe(2);
    expect(result.fixes).toEqual([]);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe("acceptance examples", () => {
  it("closes unterminated containers", () => {
    const result = repairJson('{"a":1, "b": [1, 2');
    expect(result.value).toEqual({ a: 1, b: [1, 2] });
    expect(result.text).toBe('{"a":1,"b":[1,2]}');
    expect(kinds(result)).toEqual(["close", "close"]);
  });

  it("reports mixed fixes sorted by offset", () => {
    const result = repairJson("{'a': True, b: NaN, // c\n }");
    expect(result.value).toEqual({ a: true, b: null });
    expect(result.text).toBe('{"a":true,"b":null}');
    expect(kinds(result)).toEqual([
      "quote",
      "python-literal",
      "quote",
      "non-finite-literal",
      "comma",
      "strip",
    ]);
    expect(result.fixes.map((fix) => fix.offset)).toEqual([1, 6, 12, 15, 18, 20]);
  });

  it("keeps the last duplicate key", () => {
    const result = repairJson('{"a":1,"a":2}');
    expect(result.value).toEqual({ a: 2 });
    expect(result.text).toBe('{"a":2}');
    expect(kinds(result)).toEqual(["duplicate-key"]);
    expect(result.fixes[0]?.offset).toBe(7);
    expect(result.fixes[0]?.detail).toContain("a");
  });

  it("drops a dangling key", () => {
    const result = repairJson('{"a": 1, "b": ');
    expect(result.value).toEqual({ a: 1 });
    expect(kinds(result)).toEqual(["drop-dangling-key", "close"]);
    expect(result.fixes[0]?.offset).toBe(9);
    const error = failure(() =>
      repairJson('{"a": 1, "b": ', { allowTruncation: false }),
    );
    expect(error.code).toBe("UNREPAIRABLE");
  });

  it.each(BROKEN)("is idempotent for %j", (input) => {
    const first = repairJson(input);
    const second = repairJson(first.text);
    expect(second.fixes).toEqual([]);
    expect(second.text).toBe(first.text);
    expect(second.value).toEqual(first.value);
    for (const fix of first.fixes) {
      expect(fix.detail.length).toBeLessThanOrEqual(200);
    }
  });
});

describe("limits and errors", () => {
  it("rejects hostile nesting without a RangeError", () => {
    const error = failure(() => repairJson("[".repeat(100_000)));
    expect(error.code).toBe("MAX_DEPTH");
    expect(error.offset).toBe(512);
  });

  it("honors a custom maxDepth", () => {
    expect(repairJson("[1]", { maxDepth: 1 }).value).toEqual([1]);
    const nested = failure(() => repairJson("[[1]]", { maxDepth: 1 }));
    expect(nested.code).toBe("MAX_DEPTH");
    expect(nested.offset).toBe(1);
    const object = failure(() => repairJson('{"a": {}}', { maxDepth: 1 }));
    expect(object.code).toBe("MAX_DEPTH");
  });

  it("reports MAX_DEPTH when serialization overflows the stack", () => {
    const spy = vi.spyOn(JSON, "stringify").mockImplementation(() => {
      throw new RangeError("Maximum call stack size exceeded");
    });
    let error: JsonRepairError | undefined;
    try {
      error = failure(() => repairJson("[1"));
    } finally {
      spy.mockRestore();
    }
    expect(error?.code).toBe("MAX_DEPTH");
  });

  it("enforces maxLength before parsing", () => {
    const big = failure(() => repairJson(" ".repeat(1_000_001)));
    expect(big.code).toBe("INPUT_TOO_LARGE");
    expect(big.offset).toBe(0);
    expect(repairJson("[1]", { maxLength: 3 }).value).toEqual([1]);
    const small = failure(() => repairJson("[1]", { maxLength: 2 }));
    expect(small.code).toBe("INPUT_TOO_LARGE");
  });

  it("rejects empty and whitespace-only input", () => {
    expect(failure(() => repairJson("")).code).toBe("EMPTY_INPUT");
    expect(failure(() => repairJson(" \n\t\r")).code).toBe("EMPTY_INPUT");
  });

  it("rejects non-string input", () => {
    const error = failure(() => repairJson(42 as unknown as string));
    expect(error.code).toBe("UNREPAIRABLE");
  });

  it("falls back to defaults for invalid options", () => {
    expect(repairJson("[[1]]", { maxLength: 0 }).value).toEqual([[1]]);
    expect(repairJson("[[1]]", { maxLength: 1.5 }).value).toEqual([[1]]);
    expect(repairJson("[[1]]", { maxDepth: 0 }).value).toEqual([[1]]);
    expect(repairJson("[[1]]", { maxDepth: Number.NaN }).value).toEqual([[1]]);
  });

  it("reports UNREPAIRABLE with an offset", () => {
    const cases: ReadonlyArray<readonly [string, number]> = [
      [":", 0],
      ["hello world", 0],
      ['{"a" 1}', 5],
      ['{"a":}', 5],
      ["{,}", 1],
      ["[1 }", 3],
      ['{"a":1]', 6],
      ["[foo]", 1],
      ["[-foo]", 1],
      ["[1-2]", 1],
      ["[-]", 1],
      ["[1,,2]", 3],
      ["-", 1],
      ["```", 3],
      [String.raw`"\x"`, 1],
      [String.raw`"\'"`, 1],
      ['["ab\\u12"]', 4],
    ];
    for (const [input, offset] of cases) {
      const error = failure(() => repairJson(input));
      expect({ input, code: error.code, offset: error.offset }).toEqual({
        input,
        code: "UNREPAIRABLE",
        offset,
      });
    }
  });

  it("rejects comment-only input", () => {
    const input = "// only a comment";
    const error = failure(() => repairJson(input));
    expect(error.code).toBe("UNREPAIRABLE");
    expect(error.offset).toBe(input.length);
  });

  it("exposes a typed error with a bounded message", () => {
    const error = failure(() => repairJson(`[${"a".repeat(500)}]`));
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("JsonRepairError");
    expect(error.code).toBe("UNREPAIRABLE");
    expect(error.offset).toBe(1);
    expect(error.message.length).toBeLessThanOrEqual(200);
    expect(error.message).not.toContain("a".repeat(41));
  });

  it("returns null from tryRepairJson instead of throwing", () => {
    expect(tryRepairJson(" ".repeat(1_000_001))).toBeNull();
    expect(tryRepairJson("  ")).toBeNull();
    expect(tryRepairJson(":")).toBeNull();
    expect(tryRepairJson("[1", { allowTruncation: false })).toBeNull();
    expect(tryRepairJson("[1")?.value).toEqual([1]);
  });
});

describe("truncation", () => {
  it("closes truncated input and reports each fix", () => {
    const cases: ReadonlyArray<readonly [string, unknown, readonly string[]]> = [
      ["[", [], ["close"]],
      ["{", {}, ["close"]],
      ['{"a":1', { a: 1 }, ["close"]],
      ["[1,", [1], ["comma", "close"]],
      ['{"a":1,', { a: 1 }, ["comma", "close"]],
      ['{"a"', {}, ["drop-dangling-key", "close"]],
      ['{"a":1, "b', { a: 1 }, ["drop-dangling-key", "close"]],
      ["{a", {}, ["quote", "drop-dangling-key", "close"]],
      ["[1e", [], ["number", "close"]],
      ["[1, -", [1], ["comma", "number", "close"]],
      ['{"a": -', {}, ["drop-dangling-key", "number", "close"]],
      ['{"a": "hel', { a: "hel" }, ["close", "close"]],
      ['"abc', "abc", ["close"]],
    ];
    for (const [input, value, expected] of cases) {
      const result = repairJson(input);
      expect({ input, value: result.value, kinds: kinds(result) }).toEqual({
        input,
        value,
        kinds: expected,
      });
      const strict = failure(() => repairJson(input, { allowTruncation: false }));
      expect(strict.code).toBe("UNREPAIRABLE");
    }
  });

  it("closes deeply nested truncated input", () => {
    const result = repairJson('{"a": [{"b": [1, {"c": "x');
    expect(result.value).toEqual({ a: [{ b: [1, { c: "x" }] }] });
    expect(kinds(result)).toEqual(new Array(6).fill("close"));
  });

  it("drops a backslash or partial escape at the end", () => {
    const backslash = repairJson('["ab\\');
    expect(backslash.value).toEqual(["ab"]);
    expect(kinds(backslash)).toEqual(["close", "close"]);
    expect(backslash.fixes[0]?.detail).toContain("escape");
    expect(repairJson('["ab\\u12').value).toEqual(["ab"]);
  });

  it("still repairs trailing commas when truncation is disabled", () => {
    const result = repairJson('{"a":1,}', { allowTruncation: false });
    expect(result.value).toEqual({ a: 1 });
  });
});

describe("strip fixes", () => {
  it("removes prose and code fences", () => {
    const result = repairJson(
      'Here you go:\n```json\n{"a": 1}\n```\nHope it helps!',
    );
    expect(result.value).toEqual({ a: 1 });
    expect(result.text).toBe('{"a":1}');
    expect(kinds(result)).toEqual(["strip", "strip", "strip", "strip"]);
    expect(details(result)).toEqual([
      "prose",
      "code fence",
      "code fence",
      "prose",
    ]);
  });

  it("handles fences without a language or a newline", () => {
    const plain = repairJson("```\n[1]\n```");
    expect(plain.value).toEqual([1]);
    expect(details(plain)).toEqual(["code fence", "code fence"]);
    const inline = repairJson("```json[1]```");
    expect(inline.value).toEqual([1]);
    expect(details(inline)).toEqual(["code fence", "code fence"]);
  });

  it("removes line and block comments", () => {
    const result = repairJson("/* lead */ [1, /* mid */ 2] // tail");
    expect(result.value).toEqual([1, 2]);
    expect(details(result)).toEqual([
      "block comment",
      "block comment",
      "line comment",
    ]);
  });

  it("tolerates an unterminated block comment", () => {
    const result = repairJson("[1] /* oops");
    expect(result.value).toEqual([1]);
    expect(details(result)).toEqual(["block comment"]);
  });

  it("strips leading prose and trailing text", () => {
    const leading = repairJson("Result: [1, 2]");
    expect(leading.value).toEqual([1, 2]);
    expect(details(leading)).toEqual(["prose"]);
    expect(leading.fixes[0]?.offset).toBe(0);
    const trailing = repairJson('{"a":1} trailing');
    expect(details(trailing)).toEqual(["prose"]);
    expect(trailing.fixes[0]?.offset).toBe(8);
    const second = repairJson("[1][2]");
    expect(second.value).toEqual([1]);
    expect(second.fixes[0]?.offset).toBe(3);
  });
});

describe("comma fixes", () => {
  it("removes trailing commas", () => {
    const array = repairJson("[1, 2,]");
    expect(array.value).toEqual([1, 2]);
    expect(array.text).toBe("[1,2]");
    expect(kinds(array)).toEqual(["comma"]);
    expect(array.fixes[0]?.offset).toBe(5);
    const object = repairJson('{"a":1,}');
    expect(object.value).toEqual({ a: 1 });
    expect(object.fixes[0]?.offset).toBe(6);
  });

  it("inserts missing commas", () => {
    const array = repairJson('[1 2 "x"]');
    expect(array.value).toEqual([1, 2, "x"]);
    expect(kinds(array)).toEqual(["comma", "comma"]);
    expect(array.fixes.map((fix) => fix.offset)).toEqual([3, 5]);
    const object = repairJson('{"a":1 "b":2}');
    expect(object.value).toEqual({ a: 1, b: 2 });
    expect(object.fixes[0]?.offset).toBe(7);
  });
});

describe("quote, literal and number fixes", () => {
  it("converts single-quoted strings", () => {
    const result = repairJson("{'a': 'it\\'s'}");
    expect(result.value).toEqual({ a: "it's" });
    expect(kinds(result)).toEqual(["quote", "quote"]);
    const inner = repairJson(`'say "hi"'`);
    expect(inner.value).toBe('say "hi"');
    expect(inner.text).toBe('"say \\"hi\\""');
  });

  it("quotes unquoted keys", () => {
    const result = repairJson("{a: 1, b_2: [ ], $c: 'x'}");
    expect(result.value).toEqual({ a: 1, b_2: [], $c: "x" });
    expect(kinds(result)).toEqual(["quote", "quote", "quote", "quote"]);
    const commented = repairJson("{a/*c*/: 1}");
    expect(commented.value).toEqual({ a: 1 });
    expect(kinds(commented)).toEqual(["quote", "strip"]);
  });

  it("maps Python literals", () => {
    const result = repairJson("[True, False, None]");
    expect(result.value).toEqual([true, false, null]);
    expect(kinds(result)).toEqual(new Array(3).fill("python-literal"));
    const top = repairJson("None");
    expect(top.value).toBeNull();
    expect(top.text).toBe("null");
  });

  it("maps non-finite literals to null", () => {
    const result = repairJson("[NaN, Infinity, -Infinity, +Infinity]");
    expect(result.value).toEqual([null, null, null, null]);
    expect(kinds(result)).toEqual(new Array(4).fill("non-finite-literal"));
    expect(result.fixes.map((fix) => fix.offset)).toEqual([1, 6, 16, 27]);
    const overflow = repairJson("1e999");
    expect(overflow.value).toBeNull();
    expect(kinds(overflow)).toEqual(["non-finite-literal"]);
  });

  it("normalizes lenient numbers", () => {
    const result = repairJson("[1., .5, +1, 007, -.5e1, 1.e2]");
    expect(result.value).toEqual([1, 0.5, 1, 7, -5, 100]);
    expect(kinds(result)).toEqual(new Array(6).fill("number"));
    expect(result.fixes[0]?.detail).toContain("1.");
  });

  it("bounds the detail of very long numbers", () => {
    const result = repairJson(`[${"1".repeat(300)}.]`);
    expect(kinds(result)).toEqual(["number"]);
    expect(result.fixes[0]?.detail.length).toBeLessThan(200);
  });
});

describe("string control characters", () => {
  it("escapes raw control characters", () => {
    const result = repairJson('"a\nb\tc"');
    expect(result.value).toBe("a\nb\tc");
    expect(result.text).toBe('"a\\nb\\tc"');
    expect(kinds(result)).toEqual([
      "escape-control-char",
      "escape-control-char",
    ]);
    expect(result.fixes.map((fix) => fix.offset)).toEqual([2, 4]);
    expect(result.fixes[0]?.detail).toContain("U+000A");
  });
});
