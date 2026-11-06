import { describe, expect, it } from "vitest";
import { JsonRepairError, repairJson, tryRepairJson } from "../src/index.js";

const LONE = String.fromCharCode(0xd800);
const LINE_SEP = String.fromCharCode(0x2028);
const BACKSLASH = String.fromCharCode(92);
const NO_TRUNCATION = { allowTruncation: false };

function errorOf(run: () => unknown): JsonRepairError {
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

function kinds(result: { fixes: readonly { kind: string }[] }): string[] {
  return result.fixes.map((fix) => fix.kind);
}

function offsets(result: { fixes: readonly { offset: number }[] }): number[] {
  return result.fixes.map((fix) => fix.offset);
}

function details(result: { fixes: readonly { detail: string }[] }): string[] {
  return result.fixes.map((fix) => fix.detail);
}

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

describe("truncation", () => {
  it("closes an unterminated array and object", () => {
    const result = repairJson('{"a":1, "b": [1, 2');
    expect(result.value).toEqual({ a: 1, b: [1, 2] });
    expect(result.text).toBe('{"a":1,"b":[1,2]}');
    expect(kinds(result)).toEqual(["close", "close"]);
    expect(offsets(result)).toEqual([18, 18]);
  });

  it("completes a truncated literal", () => {
    const result = repairJson("[tru");
    expect(result.value).toEqual([true]);
    expect(kinds(result)).toEqual(["close", "close"]);
    expect(offsets(result)).toEqual([4, 4]);
    expect(details(result)).toEqual(["literal", "array"]);
  });

  it("drops a trailing key that has no value", () => {
    const input = '{"a": 1, "b": ';
    const result = repairJson(input);
    expect(result.value).toEqual({ a: 1 });
    expect(kinds(result)).toEqual(["drop-dangling-key", "close"]);
    expect(offsets(result)).toEqual([9, 14]);
    const error = errorOf(() => repairJson(input, NO_TRUNCATION));
    expect(error.code).toBe("UNREPAIRABLE");
  });

  it("handles keys cut off at every position", () => {
    const keyOnly = repairJson('{"a"');
    expect(keyOnly.value).toEqual({});
    expect(kinds(keyOnly)).toEqual(["drop-dangling-key", "close"]);
    const cut = repairJson('{"a":1,"b"');
    expect(cut.value).toEqual({ a: 1 });
    expect(kinds(cut)).toEqual(["drop-dangling-key", "close"]);
    const partial = repairJson("{'a");
    expect(partial.value).toEqual({});
    expect(kinds(partial)).toEqual(["drop-dangling-key", "close"]);
    const bare = repairJson("{b");
    expect(bare.value).toEqual({});
    expect(offsets(bare)).toEqual([1, 2]);
    const nested = repairJson('{"a": {"b":');
    expect(nested.value).toEqual({ a: {} });
    expect(kinds(nested)).toEqual(["drop-dangling-key", "close", "close"]);
  });

  it("reports a trailing comma before the closing", () => {
    const object = repairJson('{"a":1,');
    expect(object.value).toEqual({ a: 1 });
    expect(kinds(object)).toEqual(["comma", "close"]);
    expect(offsets(object)).toEqual([6, 7]);
    const array = repairJson("[1,");
    expect(array.value).toEqual([1]);
    expect(kinds(array)).toEqual(["comma", "close"]);
  });

  it("closes unterminated strings", () => {
    const top = repairJson('"abc');
    expect(top.value).toBe("abc");
    expect(top.text).toBe('"abc"');
    expect(kinds(top)).toEqual(["close"]);
    const single = repairJson("['abc");
    expect(single.value).toEqual(["abc"]);
    expect(kinds(single)).toEqual(["quote", "close", "close"]);
    expect(offsets(single)).toEqual([1, 5, 5]);
  });

  it("drops a partial escape at the end of input", () => {
    const slash = repairJson(`{"a":"x${BACKSLASH}`);
    expect(slash.value).toEqual({ a: "x" });
    expect(kinds(slash)).toEqual(["close", "close"]);
    const unicode = repairJson(`["ab${BACKSLASH}u12`);
    expect(unicode.value).toEqual(["ab"]);
    expect(kinds(unicode)).toEqual(["close", "close"]);
  });

  it("rejects malformed escapes", () => {
    const bad = errorOf(() => repairJson(`["${BACKSLASH}x"]`));
    expect(bad.code).toBe("UNREPAIRABLE");
    const hex = errorOf(() => repairJson(`["${BACKSLASH}u12zz"]`));
    expect(hex.code).toBe("UNREPAIRABLE");
    const short = errorOf(() => repairJson(`["${BACKSLASH}u12"]`));
    expect(short.code).toBe("UNREPAIRABLE");
  });

  it("handles numbers and literals at the end", () => {
    expect(repairJson("[1").value).toEqual([1]);
    expect(kinds(repairJson("[1."))).toEqual(["number", "close"]);
    expect(repairJson("[nul").value).toEqual([null]);
    expect(repairJson("[fals").value).toEqual([false]);
    expect(repairJson('{"a":tr').value).toEqual({ a: true });
    expect(errorOf(() => repairJson("[tru]")).code).toBe("UNREPAIRABLE");
  });

  it("rejects a sign with no digits", () => {
    expect(errorOf(() => repairJson("-")).code).toBe("UNREPAIRABLE");
    const inArray = errorOf(() => repairJson("[1, -"));
    expect(inArray.code).toBe("UNREPAIRABLE");
    expect(inArray.offset).toBe(4);
    for (const input of ["[1e]", "[.]", "[+]", "[1e+]"]) {
      expect(errorOf(() => repairJson(input)).code).toBe("UNREPAIRABLE");
    }
  });

  it("refuses truncation when it is disabled", () => {
    for (const input of ["[1", '"abc', "[tru", '{"a":1,', "{'a"]) {
      const error = errorOf(() => repairJson(input, NO_TRUNCATION));
      expect(error.code).toBe("UNREPAIRABLE");
    }
    const complete = repairJson("[1,]", NO_TRUNCATION);
    expect(complete.value).toEqual([1]);
    expect(kinds(complete)).toEqual(["comma"]);
  });

  it("strips an unterminated block comment", () => {
    const result = repairJson("[1] /* x");
    expect(result.value).toEqual([1]);
    expect(kinds(result)).toEqual(["strip"]);
  });
});

describe("tolerant syntax", () => {
  it("repairs quotes, literals and comments together", () => {
    const result = repairJson("{'a': True, b: NaN, // c\n }");
    expect(result.value).toEqual({ a: true, b: null });
    expect(kinds(result)).toEqual([
      "quote",
      "python-literal",
      "quote",
      "non-finite-literal",
      "comma",
      "strip",
    ]);
    expect(offsets(result)).toEqual([1, 6, 12, 15, 18, 20]);
    expect(result.text).toBe('{"a":true,"b":null}');
  });

  it("accepts an escaped quote inside single quotes", () => {
    const result = repairJson("['a', 'it\\'s']");
    expect(result.value).toEqual(["a", "it's"]);
    expect(kinds(result)).toEqual(["quote", "quote"]);
    expect(offsets(result)).toEqual([1, 6]);
  });

  it("keeps a single quote inside double quotes", () => {
    const result = repairJson('["it\'s"]');
    expect(result.value).toEqual(["it's"]);
    expect(result.fixes).toEqual([]);
  });

  it("repairs trailing commas", () => {
    const array = repairJson("[1,2,]");
    expect(array.value).toEqual([1, 2]);
    expect(offsets(array)).toEqual([4]);
    const object = repairJson('{"a":1,}');
    expect(object.value).toEqual({ a: 1 });
    expect(kinds(object)).toEqual(["comma"]);
    expect(offsets(object)).toEqual([6]);
  });

  it("repairs missing commas", () => {
    const numbers = repairJson("[1 2]");
    expect(numbers.value).toEqual([1, 2]);
    expect(kinds(numbers)).toEqual(["comma"]);
    expect(offsets(numbers)).toEqual([3]);
    expect(offsets(repairJson('["a" "b"]'))).toEqual([5]);
    const object = repairJson('{"a":1 "b":2}');
    expect(object.value).toEqual({ a: 1, b: 2 });
    expect(offsets(object)).toEqual([7]);
    expect(repairJson('[1"a"]').value).toEqual([1, "a"]);
    expect(repairJson("[{} {}]").value).toEqual([{}, {}]);
  });

  it("rejects structure it cannot repair", () => {
    const invalid = [
      "[1.2.3]",
      "[12abc]",
      "[1-2]",
      "[10px]",
      "[1,,2]",
      "[,1]",
      "{,}",
      '{"a" 1}',
      '{"a":}',
      '{"a":1]',
      "[1}",
      "{1:2}",
      '{"a":hello}',
      '{"a" "b"}',
      "[trueX]",
      "[NaN-1]",
      "[}",
      "{]",
      "[-Infinityx]",
      "[Infinit]",
      "1.2.3",
      "0x10",
      "[1 }",
    ];
    for (const input of invalid) {
      expect(errorOf(() => repairJson(input)).code).toBe("UNREPAIRABLE");
    }
  });

  it("maps Python literals", () => {
    const result = repairJson("[True, False, None]");
    expect(result.value).toEqual([true, false, null]);
    expect(offsets(result)).toEqual([1, 7, 14]);
    expect(details(result)).toEqual(["True", "False", "None"]);
    expect(new Set(kinds(result))).toEqual(new Set(["python-literal"]));
  });

  it("maps non-finite literals to null", () => {
    const result = repairJson("[NaN, Infinity, -Infinity, +Infinity]");
    expect(result.value).toEqual([null, null, null, null]);
    expect(offsets(result)).toEqual([1, 6, 16, 27]);
    expect(new Set(kinds(result))).toEqual(new Set(["non-finite-literal"]));
    expect(result.text).toBe("[null,null,null,null]");
  });

  it("normalizes number lexemes", () => {
    const result = repairJson("[1., .5, +1, 007, -.5, 1.e2]");
    expect(result.value).toEqual([1, 0.5, 1, 7, -0.5, 100]);
    expect(new Set(kinds(result))).toEqual(new Set(["number"]));
    expect(offsets(result)).toEqual([1, 5, 9, 13, 18, 23]);
    expect(result.text).toBe("[1,0.5,1,7,-0.5,100]");
  });

  it("escapes raw control characters in strings", () => {
    const result = repairJson('"a\nb\tc"');
    expect(result.value).toBe("a\nb\tc");
    expect(kinds(result)).toEqual(["escape-control-char", "escape-control-char"]);
    expect(offsets(result)).toEqual([2, 4]);
    expect(result.text).toBe('"a\\nb\\tc"');
  });

  it("decodes escapes and unicode", () => {
    const text = `["${BACKSLASH}u0041${BACKSLASH}n${BACKSLASH}/${BACKSLASH}ud800"]`;
    const result = repairJson(text);
    expect(result.value).toEqual([`A\n/${LONE}`]);
    expect(result.fixes).toEqual([]);
  });

  it("re-serialises lone surrogates as escapes", () => {
    const result = repairJson(`['${LONE}']`);
    expect(result.value).toEqual([LONE]);
    expect(result.text).toBe(JSON.stringify([LONE]));
    expect(repairJson(result.text).fixes).toEqual([]);
    const raw = `["${LONE}"]`;
    const same = repairJson(raw);
    expect(same.text).toBe(raw);
    expect(same.fixes).toEqual([]);
  });

  it("keeps comments out of the value", () => {
    const result = repairJson("/* a */ [1, // b\n 2] // c");
    expect(result.value).toEqual([1, 2]);
    expect(kinds(result)).toEqual(["strip", "strip", "strip"]);
    expect(offsets(result)).toEqual([0, 12, 21]);
    expect(details(result)).toEqual(["comment", "comment", "comment"]);
  });
});

describe("prose, fences and byte order marks", () => {
  it("strips a code fence and trailing prose", () => {
    const input = '```json\n{"a":1}\n```\nHope this helps';
    const result = repairJson(input);
    expect(result.value).toEqual({ a: 1 });
    expect(new Set(kinds(result))).toEqual(new Set(["strip"]));
    expect(offsets(result)).toEqual([0, 16, 20]);
    expect(details(result)).toEqual(["fence", "fence", "prose"]);
  });

  it("strips a fence without a language", () => {
    const result = repairJson("```\n[1]\n```");
    expect(result.value).toEqual([1]);
    expect(offsets(result)).toEqual([0, 8]);
    expect(details(result)).toEqual(["fence", "fence"]);
  });

  it("strips leading and trailing prose", () => {
    const result = repairJson('Sure! Here you go: {"a":1} hope that helps');
    expect(result.value).toEqual({ a: 1 });
    expect(offsets(result)).toEqual([0, 27]);
    expect(details(result)).toEqual(["prose", "prose"]);
    expect(repairJson("Result: [1, 2]").value).toEqual([1, 2]);
    expect(repairJson('{"a":1}{"b":2}').value).toEqual({ a: 1 });
  });

  it("strips prose after a bare value", () => {
    const result = repairJson("42 is the answer");
    expect(result.value).toBe(42);
    expect(result.text).toBe("42");
    expect(details(result)).toEqual(["prose"]);
    expect(offsets(result)).toEqual([3]);
  });

  it("treats leading scalar-looking prose as prose before a container", () => {
    expect(repairJson('None of these: {"a":1}').value).toEqual({ a: 1 });
    expect(repairJson('True story: {"a":1}').value).toEqual({ a: 1 });
    expect(repairJson('1. Here is {"a":1}').value).toEqual({ a: 1 });
    expect(repairJson("42\n```").value).toBe(42);
  });

  it("rejects text that does not lead to a value", () => {
    const sure = errorOf(() => repairJson("Sure: 42"));
    expect(sure.code).toBe("UNREPAIRABLE");
    expect(sure.offset).toBe(0);
    const colon = errorOf(() => repairJson(":"));
    expect(colon.code).toBe("UNREPAIRABLE");
    expect(colon.offset).toBe(0);
    const comment = errorOf(() => repairJson("// only a comment"));
    expect(comment.code).toBe("UNREPAIRABLE");
    expect(tryRepairJson("Sure: 42")).toBeNull();
    expect(tryRepairJson(":")).toBeNull();
  });

  it("reports empty input", () => {
    for (const input of ["", "   ", "\n\t "]) {
      expect(errorOf(() => repairJson(input)).code).toBe("EMPTY_INPUT");
      expect(tryRepairJson(input)).toBeNull();
    }
  });

  it("strips a byte order mark and unescapes a quote", () => {
    const result = repairJson(`\uFEFF{"a":"it\\'s"}`);
    expect(result.value).toEqual({ a: "it's" });
    expect(result.text).toBe('{"a":"it\'s"}');
    expect(kinds(result)).toEqual(["strip", "quote"]);
    expect(offsets(result)).toEqual([0, 9]);
    expect(result.fixes[0]?.detail).toBe("bom");
  });

  it("strips a byte order mark from valid JSON", () => {
    const result = repairJson(`${String.fromCharCode(0xfeff)}[1]`);
    expect(result.text).toBe("[1]");
    expect(kinds(result)).toEqual(["strip"]);
  });
});

describe("objects", () => {
  it("creates __proto__ as a plain own property", () => {
    const result = repairJson('{"__proto__": {"x": 1}}');
    const value = result.value as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect(result.fixes).toEqual([]);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it("keeps __proto__ own after a repair", () => {
    const result = repairJson("{'__proto__': {'x': 1}}");
    const value = result.value as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value)).toEqual(["__proto__"]);
    expect(result.text).toBe('{"__proto__":{"x":1}}');
  });

  it("keeps the last duplicate and reports it", () => {
    const result = repairJson('{"a":1,"a":2}');
    expect(result.value).toEqual({ a: 2 });
    expect(kinds(result)).toEqual(["duplicate-key"]);
    expect(offsets(result)).toEqual([7]);
    expect(result.text).toBe('{"a":2}');
  });

  it("reports a duplicate whose value is a container", () => {
    const result = repairJson('{"a":{"x":1},"a":[2]}');
    expect(result.value).toEqual({ a: [2] });
    expect(offsets(result)).toEqual([13]);
  });

  it("does not report a duplicate that is dropped", () => {
    const result = repairJson('{"a":1,"a":');
    expect(result.value).toEqual({ a: 1 });
    expect(kinds(result)).toEqual(["drop-dangling-key", "close"]);
  });
});

describe("numbers", () => {
  it("reports every lossy re-serialisation", () => {
    const result = repairJson("[9007199254740993, -0, 1e400,]");
    expect(result.text).toBe("[9007199254740992,0,null]");
    expect(kinds(result)).toEqual(["number", "number", "number", "comma"]);
    expect(offsets(result)).toEqual([1, 19, 23, 28]);
    expect(details(result).slice(0, 3)).toEqual(["precision", "negative-zero", "out-of-range"]);
    expect((result.value as number[])[2]).toBe(Infinity);
  });

  it("does not report loss when the input is returned as is", () => {
    const input = "[9007199254740993, -0, 1e400]";
    const result = repairJson(input);
    expect(result.text).toBe(input);
    expect(result.fixes).toEqual([]);
    expect((result.value as number[])[2]).toBe(Infinity);
  });

  it("reports underflow and negative zero spellings", () => {
    const under = repairJson("[1e-400,]");
    expect(kinds(under)).toEqual(["number", "comma"]);
    expect(details(under)[0]).toBe("out-of-range");
    expect(under.text).toBe("[0]");
    const negative = repairJson("[-0.0,]");
    expect(details(negative)[0]).toBe("negative-zero");
    expect(negative.text).toBe("[0]");
  });

  it("reports normalisation and precision at one offset", () => {
    const result = repairJson("[+9007199254740993]");
    expect(offsets(result)).toEqual([1, 1]);
    expect(details(result)).toEqual(["normalized", "precision"]);
    expect(result.text).toBe("[9007199254740992]");
  });

  it("does not report safe integers or valid exponents", () => {
    const safe = repairJson("[9007199254740991,]");
    expect(kinds(safe)).toEqual(["comma"]);
    const big = repairJson("[100000000000000000000000,]");
    expect(details(big)[0]).toBe("precision");
    const valid = repairJson("[1e5, 1E+5, 1.5e-3]");
    expect(valid.fixes).toEqual([]);
  });
});

describe("limits and options", () => {
  it("bounds nesting without a RangeError", () => {
    const error = errorOf(() => repairJson("[".repeat(100_000)));
    expect(error.code).toBe("MAX_DEPTH");
    expect(error.offset).toBe(512);
  });

  it("honours maxDepth exactly", () => {
    const options = { maxDepth: 3 };
    expect(repairJson("[[[]]]", options).fixes).toEqual([]);
    const error = errorOf(() => repairJson("[[[[]]]]", options));
    expect(error.code).toBe("MAX_DEPTH");
    expect(error.offset).toBe(3);
    const ok = `${"[".repeat(512)}${"]".repeat(512)}`;
    expect(repairJson(ok).text).toBe(ok);
    const deep = `${"[".repeat(513)}${"]".repeat(513)}`;
    expect(errorOf(() => repairJson(deep)).code).toBe("MAX_DEPTH");
  });

  it("reports values that are too deep to serialise", () => {
    const options = { maxDepth: 1_000_000, maxFixes: 1_000_000 };
    const error = errorOf(() => repairJson("[".repeat(200_000), options));
    expect(error.code).toBe("MAX_DEPTH");
  });

  it("rejects oversized input before parsing", () => {
    const options = { maxLength: 10 };
    const error = errorOf(() => repairJson("x".repeat(11), options));
    expect(error.code).toBe("INPUT_TOO_LARGE");
    const edge = errorOf(() => repairJson("x".repeat(10), options));
    expect(edge.code).toBe("UNREPAIRABLE");
    const huge = errorOf(() => repairJson("[".repeat(1_000_001)));
    expect(huge.code).toBe("INPUT_TOO_LARGE");
    const blank = errorOf(() => repairJson(" ".repeat(1_000_001)));
    expect(blank.code).toBe("INPUT_TOO_LARGE");
    expect(tryRepairJson("x".repeat(11), options)).toBeNull();
  });

  it("rejects invalid options with a TypeError", () => {
    expect(() => repairJson("{}", { maxDepth: 0 })).toThrow(TypeError);
    const bad = [
      '{"maxLength":0}',
      '{"maxLength":-1}',
      '{"maxLength":1.5}',
      '{"maxLength":"10"}',
      '{"maxLength":9007199254740992}',
      '{"maxDepth":null}',
      '{"maxFixes":0}',
      '{"allowTruncation":"yes"}',
      '{"allowTruncation":null}',
      "5",
      "null",
    ];
    for (const text of bad) {
      const options = JSON.parse(text);
      expect(() => repairJson("{}", options)).toThrow(TypeError);
      expect(() => tryRepairJson("{}", options)).toThrow(TypeError);
    }
    expect(() => repairJson(JSON.parse("5"))).toThrow(TypeError);
  });

  it("limits the number of fixes", () => {
    const input = "{'a': True, b: NaN}";
    const error = errorOf(() => repairJson(input, { maxFixes: 3 }));
    expect(error.code).toBe("TOO_MANY_FIXES");
    expect(repairJson(input, { maxFixes: 4 }).fixes).toHaveLength(4);
    const closes = errorOf(() => repairJson("[".repeat(50), { maxFixes: 10 }));
    expect(closes.code).toBe("TOO_MANY_FIXES");
    expect(tryRepairJson(input, { maxFixes: 3 })).toBeNull();
  });

  it("counts lossy number fixes only when text is rewritten", () => {
    const options = { maxFixes: 1 };
    const error = errorOf(() => repairJson("[9007199254740993,]", options));
    expect(error.code).toBe("TOO_MANY_FIXES");
    const same = repairJson("[9007199254740993,9007199254740993]", options);
    expect(same.fixes).toEqual([]);
    const three = "[9007199254740993,9007199254740993,9007199254740993]";
    expect(repairJson(three, options).fixes).toEqual([]);
  });

  it("quotes at most 40 input characters in messages", () => {
    const error = errorOf(() => repairJson(`[${"y".repeat(100)}]`));
    expect(error.message.length).toBeLessThanOrEqual(200);
    expect(error.message).toContain("y".repeat(40));
    expect(error.message).not.toContain("y".repeat(41));
    expect(error.name).toBe("JsonRepairError");
    expect(error).toBeInstanceOf(Error);
  });

  it("returns null from tryRepairJson only for repair errors", () => {
    expect(tryRepairJson('{"a":1}')?.value).toEqual({ a: 1 });
    expect(tryRepairJson("[".repeat(100_000))).toBeNull();
    expect(tryRepairJson("")).toBeNull();
  });
});

describe("idempotence and properties", () => {
  const valid = [
    "null",
    "true",
    "false",
    "0",
    "-0",
    "[-0]",
    "1.5e10",
    "-12.5E+3",
    '""',
    "[]",
    "{}",
    ' { "a" : [ 1 , 2 , { "b" : null } ] } ',
    "\n[1,\n2]\n",
    '{"__proto__":1}',
    '{"a":{"b":{"c":[[]]}}}',
    `"a${BACKSLASH}nb"`,
    `"${BACKSLASH}u00e9${BACKSLASH}ud800"`,
    `"${BACKSLASH}/"`,
    `["${LONE}"]`,
    `"${LINE_SEP}"`,
  ];

  it("returns valid JSON untouched", () => {
    for (const input of valid) {
      const result = repairJson(input);
      expect(result.text).toBe(input);
      expect(result.fixes).toEqual([]);
      const expected = JSON.stringify(JSON.parse(input));
      expect(JSON.stringify(result.value)).toBe(expected);
    }
  });

  it("is idempotent on repaired text", () => {
    const messy = [
      '{"a":1, "b": [1, 2',
      "[tru",
      '{"a": 1, "b": ',
      "{'a': True, b: NaN, // c\n }",
      '{"a":1,"a":2}',
      "[9007199254740993, -0, 1e400,]",
      "[1., .5, +1, 007, -.5]",
      '```json\n{"a":1}\n```\nHope this helps',
      "['a', 'b'",
      '{"a":"x',
      "/* c */ [1,\n2,]",
    ];
    for (const input of messy) {
      const first = repairJson(input);
      const second = repairJson(first.text);
      expect(second.fixes).toEqual([]);
      expect(second.text).toBe(first.text);
      expect(JSON.stringify(second.value)).toBe(first.text);
    }
  });

  const sample = JSON.stringify({
    name: 'Ada "L"',
    tags: ["x", "y", [1, 2.5, -300]],
    ok: true,
    none: null,
    nested: { k: "é", s: LONE },
  });

  it("repairs or rejects every prefix of a document", () => {
    let repaired = 0;
    for (let end = 1; end < sample.length; end += 1) {
      const result = tryRepairJson(sample.slice(0, end));
      if (result !== null) {
        repaired += 1;
        expect(() => JSON.parse(result.text)).not.toThrow();
        expect(repairJson(result.text).fixes).toEqual([]);
      }
    }
    expect(repaired).toBeGreaterThan(50);
    expect(repairJson(sample).fixes).toEqual([]);
  });

  it("only ever throws JsonRepairError on garbage", () => {
    const alphabet = `{}[]",: 'truefalsnNI01-+.eE/*${BACKSLASH}\n`;
    const next = seeded(7);
    for (let run = 0; run < 3000; run += 1) {
      const length = 1 + Math.floor(next() * 24);
      let text = "";
      for (let i = 0; i < length; i += 1) {
        text += alphabet.charAt(Math.floor(next() * alphabet.length));
      }
      const result = tryRepairJson(text);
      if (result !== null) {
        expect(() => JSON.parse(result.text)).not.toThrow();
        expect(repairJson(result.text).fixes).toEqual([]);
      }
    }
  });

  it("round-trips random documents", () => {
    const next = seeded(11);
    const build = (depth: number): unknown => {
      const pick = Math.floor(next() * (depth > 3 ? 4 : 6));
      if (pick === 0) {
        return Math.floor(next() * 1000) - 500;
      }
      if (pick === 1) {
        return next() < 0.5;
      }
      if (pick === 2) {
        return null;
      }
      if (pick === 3) {
        return `s${Math.floor(next() * 100)}"${BACKSLASH}`;
      }
      if (pick === 4) {
        return Array.from({ length: Math.floor(next() * 4) }, () => build(depth + 1));
      }
      const entries = Array.from({ length: Math.floor(next() * 4) }, (_, i) => [
        `k${i}`,
        build(depth + 1),
      ]);
      return Object.fromEntries(entries);
    };
    for (let run = 0; run < 200; run += 1) {
      const text = JSON.stringify(build(0), null, run % 3);
      const result = repairJson(text);
      expect(result.text).toBe(text);
      expect(result.fixes).toEqual([]);
      expect(result.value).toEqual(JSON.parse(text));
    }
  });
});
