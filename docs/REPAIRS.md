# Repairs

`repairJson` runs one tolerant pass over the input with an explicit stack (no recursion), so nesting is bounded
by `maxDepth` and never by the call stack. Every change is reported as a `Fix` with a `kind`, an `offset` (UTF-16
index into the original input) and a short `detail`. Fixes are sorted by offset.

| Kind | What it repairs |
|---|---|
| `strip` | Prose before or after the value, code fences, line comments and block comments. `detail` names which. |
| `comma` | Trailing commas and missing commas. |
| `quote` | Single-quoted strings and unquoted object keys. |
| `python-literal` | `True`, `False` and `None`. |
| `non-finite-literal` | `NaN`, `Infinity`, `-Infinity` and numbers that overflow, all replaced by `null`. |
| `number` | `1.`, `.5`, `+1`, leading zeros, and an incomplete number at the end of truncated input (dropped). |
| `escape-control-char` | Raw control characters inside strings. |
| `close` | An unterminated string, array or object at the end of input (one fix per closed token). |
| `drop-dangling-key` | A trailing key without a value, together with its preceding comma. |
| `duplicate-key` | A repeated member name (RFC 8259 section 4); the last value is kept. |

Invalid escape sequences such as `\x` are not repaired: they throw `UNREPAIRABLE` because no fix kind describes
them honestly. When nothing was fixed, `text` is the original input; otherwise it is compact `JSON.stringify`
output, so `repairJson(result.text)` always returns no fixes.

## Errors

`JsonRepairError` has a stable `code` (`INPUT_TOO_LARGE`, `EMPTY_INPUT`, `UNREPAIRABLE`, `MAX_DEPTH`) and an
`offset`. Messages quote at most 40 characters of input. `tryRepairJson` returns `null` instead of throwing.

## Safety

Object members are created with `Object.defineProperty`, so keys such as `__proto__` and `constructor` become plain
own properties and never reach a prototype.
