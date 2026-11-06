# Usage

`@trysac/json-repair` repairs truncated or malformed JSON produced by language models and reports every change it made.

```ts
import { repairJson, tryRepairJson, JsonRepairError } from "@trysac/json-repair";

const result = repairJson('{"a":1, "b": [1, 2');
result.value; // { a: 1, b: [1, 2] }
result.text; // '{"a":1,"b":[1,2]}'
result.fixes; // [{ kind: "close", offset: 18, detail: "array" }, ...]
```

## Result

- `value` is the parsed value. Objects are built with `Object.defineProperty`, so a `__proto__` key is a plain own property.
- `text` is the input itself when no fix was needed, otherwise the compact `JSON.stringify(value)`.
- `fixes` are sorted by UTF-16 offset into the original input.

## Fix kinds

| Kind | Meaning |
|---|---|
| `strip` | Removes a BOM (`bom`), prose (`prose`), code fences (`fence`) or comments (`comment`). |
| `comma` | Removes a trailing comma or inserts a missing one. |
| `quote` | Converts a single-quoted string or an unquoted key, or unescapes `\'` inside a double-quoted string. |
| `python-literal` | Maps `True`, `False` and `None`. |
| `non-finite-literal` | Maps `NaN` and `+-Infinity` to `null`. |
| `number` | Normalizes `1.`, `.5`, `+1` and leading zeros, and reports lossy re-serialisation (`precision`, `negative-zero`, `out-of-range`). |
| `escape-control-char` | Escapes a raw control character inside a string. |
| `close` | Completes an unterminated string, array, object or truncated literal at the end of input, one fix per token. |
| `drop-dangling-key` | Removes a trailing key without a value, together with its comma. |
| `duplicate-key` | A repeated name; the last value is kept (RFC 8259 section 4 says names SHOULD be unique). |

Lossy number fixes are only reported when the text is re-serialised, because with zero other fixes `text` is the untouched input.

## Errors

`JsonRepairError` carries a stable `code` and an `offset`: `INPUT_TOO_LARGE`, `EMPTY_INPUT`, `UNREPAIRABLE`, `MAX_DEPTH` and `TOO_MANY_FIXES`. Messages quote at most 40 characters of input. `tryRepairJson` returns `null` instead of throwing a `JsonRepairError`. Invalid options throw a `TypeError`.

## Limits

| Option | Default | Meaning |
|---|---|---|
| `maxLength` | 1_000_000 | Input length in UTF-16 units, checked before parsing. |
| `maxDepth` | 512 | Container nesting; the parser uses an explicit stack, never recursion. |
| `maxFixes` | 10_000 | Maximum number of fixes. |
| `allowTruncation` | true | When false, input that needs a `close` or `drop-dangling-key` fix is `UNREPAIRABLE`. |

## What is not repaired

- Leading text that cannot start a value is prose and is only stripped up to the first `{`, `[` or code fence, so `Sure: 42` is `UNREPAIRABLE`.
- A sign or `.` without digits, such as `-` at the end of input, and an incomplete exponent such as `1e` are `UNREPAIRABLE`.
- Escapes other than the JSON escapes and `\'` are `UNREPAIRABLE`.
- A missing comma is only inserted when whitespace or a quote or bracket separates the two tokens, so `[1.2.3]` and `[12abc]` are rejected.
- JSON5, streaming input and YAML are out of scope.
