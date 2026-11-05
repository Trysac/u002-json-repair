# Architecture

## Overview

`@trysac/json-repair` is a small, dependency-free TypeScript library published to npm as ES modules with type declarations. It repairs truncated or malformed JSON with a single-pass tolerant parser that uses an explicit stack (no recursion) and reports every fix with its UTF-16 input offset.

## Modules

| Module | Responsibility |
|---|---|
| `src/index.ts` | Public API: `repairJson`, `tryRepairJson`, and re-exports of types and `JsonRepairError`. |
| `src/parser.ts` | Tolerant single-pass parser with an explicit stack; records fixes. |
| `src/errors.ts` | `JsonRepairError` and its stable error codes. |
| `src/text.ts` | Helpers: bounded printable excerpts for messages and JSON whitespace check. |
| `src/types.ts` | Public types: `Fix`, `FixKind`, `RepairOptions`, `RepairResult`. |

Add a row when you add a module. Internal modules are not re-exported unless they are part of the public API.

## Boundaries

- No runtime dependencies. The source does not import `node:` modules, so it runs in browsers.
- No I/O at import time. Functions are pure.
- Errors are thrown as `JsonRepairError` with a stable `code` (`INPUT_TOO_LARGE`, `EMPTY_INPUT`, `UNREPAIRABLE`, `MAX_DEPTH`) and an `offset`. Messages are capped at 200 characters.
- Object members are created with `Object.defineProperty`, so keys such as `__proto__` are plain own properties.
- Nesting depth is bounded by `maxDepth` (default 512) and never by the call stack.

## Build and distribution

`npm run build` compiles `src/` to `dist/` with `tsconfig.build.json`. Only `dist/` is published
(`files` in `package.json`).

## Decisions

Architectural decisions are recorded in [decisions/](decisions/), starting with
[0001](decisions/0001-record-architecture-decisions.md).
