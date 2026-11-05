const EXCERPT_LIMIT = 40;

/**
 * Returns a printable excerpt of `text` for use in error messages.
 *
 * At most 40 characters of input are kept, control characters become `?` and
 * a `...` suffix marks truncation.
 *
 * @param text - Untrusted text.
 * @returns A short single-line excerpt.
 */
export function excerpt(text: string): string {
  const count = Math.min(text.length, EXCERPT_LIMIT);
  let out = "";
  for (let i = 0; i < count; i++) {
    out += text.charCodeAt(i) < 0x20 ? "?" : text.charAt(i);
  }
  return text.length > EXCERPT_LIMIT ? `${out}...` : out;
}

/**
 * True for the four insignificant whitespace characters of RFC 8259.
 *
 * @param code - A UTF-16 code unit.
 * @returns Whether the code unit is JSON whitespace.
 */
export function isJsonSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}
