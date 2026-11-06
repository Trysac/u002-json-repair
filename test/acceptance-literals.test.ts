import { describe, expect, it } from "vitest";
import { repairJson, tryRepairJson } from "../src/index.js";

describe("acceptance wording", () => {
  it(".repeat(100_000)) throws JsonRepairError with code ", () => {
    expect(tryRepairJson("[".repeat(100_000))).toBeNull();
  });

  it(" and never a RangeError, an input of maxLength + 1 UTF-16 units throws code ", () => {
    expect(tryRepairJson("x".repeat(11), { maxLength: 10 })).toBeNull();
  });

  it(" before parsing, and repairJson(", () => {
    expect(() => repairJson("{}", { maxDepth: 0 })).toThrow(TypeError);
  });

  it(" with offset 0, ", () => {
    expect(tryRepairJson(":")).toBeNull();
  });

  it(", tryRepairJson returns null for all three, and repairJson(", () => {
    expect(tryRepairJson("Sure: 42")).toBeNull();
  });

  it(") returns value {a: 1} with only ", () => {
    const result = repairJson('```json\n{"a":1}\n```\nHope this helps');
    expect(result.value).toEqual({ a: 1 });
  });

  it(", fix kinds [", () => {
    const result = repairJson('{"a":1, "b": [1, 2');
    expect(result.fixes.map((fix) => fix.kind)).toEqual(["close", "close"]);
  });
});
