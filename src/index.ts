/**
 * Public entry point of @trysac/json-repair.
 *
 * Repairs truncated or malformed JSON (typically produced by an LLM) with an
 * iterative tolerant parser and reports every fix with its input offset.
 */

import { JsonRepairError } from "./errors.js";
import { parse } from "./parser.js";
import { isJsonSpace } from "./text.js";
import type { RepairOptions, RepairResult } from "./types.js";

export { JsonRepairError, type JsonRepairErrorCode } from "./errors.js";
export type { Fix, FixKind, RepairOptions, RepairResult } from "./types.js";

const DEFAULT_MAX_LENGTH = 1_000_000;
const DEFAULT_MAX_DEPTH = 512;

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function isBlank(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (!isJsonSpace(text.charCodeAt(i))) {
      return false;
    }
  }
  return true;
}

function serialize(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    throw new JsonRepairError(
      "MAX_DEPTH",
      "repaired value is too deeply nested to serialize",
      0,
    );
  }
}

/**
 * Repairs `input` and returns the parsed value, the repaired text and the list
 * of fixes applied.
 *
 * When no fix was needed `text` is the original input; otherwise it is the
 * compact `JSON.stringify` of `value`. Object members are own data properties,
 * so keys such as `__proto__` never touch a prototype. Invalid option values
 * fall back to their defaults.
 *
 * @param input - Text to repair.
 * @param options - Limits and truncation policy.
 * @returns The repair result; `fixes` is sorted by input offset.
 * @throws {JsonRepairError} `INPUT_TOO_LARGE`, `EMPTY_INPUT`, `UNREPAIRABLE`
 * or `MAX_DEPTH`.
 */
export function repairJson(
  input: string,
  options: RepairOptions = {},
): RepairResult {
  if (typeof input !== "string") {
    throw new JsonRepairError("UNREPAIRABLE", "input must be a string", 0);
  }
  const maxLength = positiveInteger(options.maxLength, DEFAULT_MAX_LENGTH);
  const maxDepth = positiveInteger(options.maxDepth, DEFAULT_MAX_DEPTH);
  if (input.length > maxLength) {
    throw new JsonRepairError(
      "INPUT_TOO_LARGE",
      `input length ${input.length} exceeds maxLength ${maxLength}`,
      0,
    );
  }
  if (isBlank(input)) {
    throw new JsonRepairError("EMPTY_INPUT", "input is empty", 0);
  }
  const { value, fixes } = parse(
    input,
    maxDepth,
    options.allowTruncation ?? true,
  );
  if (fixes.length === 0) {
    return { value, text: input, fixes };
  }
  return { value, text: serialize(value), fixes };
}

/**
 * Like {@link repairJson} but never throws.
 *
 * @param input - Text to repair.
 * @param options - Limits and truncation policy.
 * @returns The repair result, or `null` when the input cannot be repaired.
 */
export function tryRepairJson(
  input: string,
  options: RepairOptions = {},
): RepairResult | null {
  try {
    return repairJson(input, options);
  } catch {
    return null;
  }
}
