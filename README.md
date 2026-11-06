# json-repair

[![npm version](https://img.shields.io/npm/v/@trysac/json-repair.svg)](https://www.npmjs.com/package/@trysac/json-repair)
[![license: MIT](https://img.shields.io/npm/l/@trysac/json-repair.svg)](LICENSE)
[![CI](https://github.com/Trysac/u002-json-repair/actions/workflows/ci.yml/badge.svg)](https://github.com/Trysac/u002-json-repair/actions/workflows/ci.yml)

Repair truncated or malformed JSON returned by an LLM with an iterative tolerant parser and an offset-annotated report of every fix, zero dependencies

## Problem

LLM output is often cut off at the token limit, wrapped in prose or code fences, or written with comments, trailing commas, single quotes, or Python or NaN literals. `JSON.parse` rejects all of it. This library parses such text in one pass with an explicit stack, returns the value and the repaired text, and lists every fix with its UTF-16 offset. Input that cannot be repaired within its limits raises a typed error.

## Install

```sh
npm install @trysac/json-repair
```

Requires Node.js 20 or newer. The package ships ES modules with TypeScript declarations and has no runtime dependencies.

## Usage

```ts
import { repairJson } from "@trysac/json-repair";

const result = repairJson('{"a":1, "b": [1, 2');
console.log(result.value); // { a: 1, b: [ 1, 2 ] }
console.log(result.text); // {"a":1,"b":[1,2]}
for (const fix of result.fixes) {
  console.log(fix.kind, fix.offset, fix.detail); // close 18 array, close 18 object
}
```

## API

| Export | Signature | Description |
|---|---|---|
| `repairJson` | `(input: string, options?: RepairOptions) => RepairResult` | Repairs `input`; throws `JsonRepairError`. |
| `tryRepairJson` | `(input: string, options?: RepairOptions) => RepairResult \| null` | Like `repairJson` but returns `null` on a `JsonRepairError`. |
| `JsonRepairError` | `class extends Error` | Has `code` and `offset`. |

`RepairOptions`:

- `maxLength`: default 1,000,000 UTF-16 units. Longer input throws `INPUT_TOO_LARGE` before parsing.
- `maxDepth`: default 512 container levels. Deeper nesting throws `MAX_DEPTH`.
- `maxFixes`: default 10,000. Needing more fixes throws `TOO_MANY_FIXES`.
- `allowTruncation`: default `true`. When `false`, input cut off mid-value throws `UNREPAIRABLE`.

A limit that is not a positive safe integer, a non-boolean `allowTruncation`, or non-object options throws `TypeError`. A non-string input also throws `TypeError`.

`RepairResult`: `{ value: unknown; text: string; fixes: Fix[] }`. `text` is the input itself when no fix was needed, otherwise the compact `JSON.stringify(value)`. Each `Fix` is `{ kind, offset, detail }`, with `offset` a UTF-16 index into the input, sorted ascending.

Fix kinds: `strip` (BOM, prose, code fence, comment), `comma` (trailing or missing comma), `quote` (single-quoted string, unquoted key, escaped single quote), `python-literal` (True, False, None), `non-finite-literal` (NaN, Infinity, mapped to null), `number` (normalized lexeme, or precision, negative-zero or out-of-range loss when text is rewritten), `escape-control-char`, `close` (closing an unterminated string, array, object or truncated literal at end of input), `drop-dangling-key`, `duplicate-key` (last value kept).

Error codes: `INPUT_TOO_LARGE`, `EMPTY_INPUT` (empty or whitespace-only input), `UNREPAIRABLE` (no value found, or structure that cannot be repaired), `MAX_DEPTH`, `TOO_MANY_FIXES`.

Limits of the repair: text before the first `{`, `[` or code fence that cannot start a value is stripped as prose, so `Sure: 42` is `UNREPAIRABLE`. Only `\'` is accepted as an invalid escape; other invalid escapes are `UNREPAIRABLE`. Duplicate keys are reported but not rejected.

See [docs/SECURITY.md](docs/SECURITY.md) for the threat model and the limits that do not protect against.

## Why not jsonrepair

`jsonrepair` returns only a repaired string. This library returns the parsed value together with offset-annotated fixes, so callers can inspect each repair and reject the result when a fix is unacceptable.

## Development

```sh
npm install
npm run check   # lint, format, types, tests with coverage, docs, secrets
```

See [AGENTS.md](AGENTS.md) for the full command list and [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow.

## License

[MIT](LICENSE) © 2026 Miguel Gomez
