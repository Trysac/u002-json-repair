# json-repair

[![npm version](https://img.shields.io/npm/v/@trysac/json-repair.svg)](https://www.npmjs.com/package/@trysac/json-repair)
[![license: MIT](https://img.shields.io/npm/l/@trysac/json-repair.svg)](LICENSE)
[![CI](https://github.com/Trysac/u002-json-repair/actions/workflows/ci.yml/badge.svg)](https://github.com/Trysac/u002-json-repair/actions/workflows/ci.yml)

Repair truncated or malformed JSON returned by an LLM with an iterative tolerant parser and an offset-annotated report of every fix, zero dependencies

## Problem

LLMs return JSON cut off at the token limit, wrapped in prose or code fences, or written with comments, trailing commas, single quotes, unquoted keys, and Python or NaN literals. `JSON.parse` rejects all of these. Naive repair approaches rewrite strings with regexes, recurse until the stack overflows on hostile input, or let a `__proto__` key reach the prototype. This library repairs the common failure modes deterministically and reports exactly what it changed, so callers can reject risky repairs.

## Install

```sh
npm install @trysac/json-repair
```

Requires Node.js 20 or newer. The package ships ES modules with TypeScript declarations.

## Usage

```ts
import { repairJson } from "@trysac/json-repair";

const result = repairJson('{"a":1, "b": [1, 2');
console.log(result.value); // { a: 1, b: [ 1, 2 ] }
console.log(result.text); // {"a":1,"b":[1,2]}
console.log(result.fixes.map((fix) => fix.kind)); // [ 'close', 'close' ]
```

## API

| Export | Signature | Description |
|---|---|---|
| `repairJson` | `(input: string, options?: RepairOptions) => RepairResult` | Repairs the input; throws `JsonRepairError` on failure. |
| `tryRepairJson` | `(input: string, options?: RepairOptions) => RepairResult \| null` | Same as `repairJson` but returns `null` instead of throwing. |
| `JsonRepairError` | class extends `Error` | Carries `code` and `offset`. |

## Development

```sh
npm install
npm run check   # lint, format, types, tests with coverage, docs, secrets
```

See [AGENTS.md](AGENTS.md) for the full command list and [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow.

## License

[MIT](LICENSE) © 2026 Miguel Gomez
