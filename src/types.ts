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

/** One repair applied to the input. */
export interface Fix {
  /** What kind of repair was applied. */
  readonly kind: FixKind;
  /** UTF-16 index into the original input where the problem was found. */
  readonly offset: number;
  /** Short human-readable description (well under 200 characters). */
  readonly detail: string;
}

/** Options accepted by `repairJson` and `tryRepairJson`. */
export interface RepairOptions {
  /** Maximum input length in UTF-16 units. Default 1_000_000. */
  readonly maxLength?: number;
  /** Maximum nesting depth of arrays and objects. Default 512. */
  readonly maxDepth?: number;
  /** Whether truncated input may be closed at its end. Default true. */
  readonly allowTruncation?: boolean;
}

/** Outcome of a successful repair. */
export interface RepairResult {
  /** The parsed value. */
  readonly value: unknown;
  /** The input itself when nothing was fixed, else compact JSON text. */
  readonly text: string;
  /** Every fix applied, sorted by offset. */
  readonly fixes: Fix[];
}
