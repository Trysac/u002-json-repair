/** Stable machine-readable error codes of this library. */
export type JsonRepairErrorCode =
  | "INPUT_TOO_LARGE"
  | "EMPTY_INPUT"
  | "UNREPAIRABLE"
  | "MAX_DEPTH";

const MAX_MESSAGE_LENGTH = 200;

/** Base (and only) error class of the library. */
export class JsonRepairError extends Error {
  /** Stable machine-readable code. */
  readonly code: JsonRepairErrorCode;
  /** UTF-16 index into the input that the error refers to. */
  readonly offset: number;

  /**
   * Creates an error.
   *
   * @param code - Stable error code.
   * @param message - Human-readable message; capped at 200 characters.
   * @param offset - UTF-16 index into the input.
   */
  constructor(code: JsonRepairErrorCode, message: string, offset: number) {
    super(message.slice(0, MAX_MESSAGE_LENGTH));
    this.name = "JsonRepairError";
    this.code = code;
    this.offset = offset;
  }
}
