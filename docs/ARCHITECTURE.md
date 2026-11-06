# Architecture

## Overview

`@trysac/json-repair` is a small, dependency-free TypeScript library published to npm as ES modules with type declarations. It repairs truncated or malformed JSON returned by an LLM with an iterative tolerant parser and reports every fix with an offset.

The parser is a single pass over the input with an explicit stack of container frames. It does not recurse, so nesting is bounded by `maxDepth` and not by the call stack. The parser is a private class `Repairer` inside `src/index.ts`.

## Modules

| Module | Responsibility |
|---|---|
| `src/index.ts` | Public API: `repairJson`, `tryRepairJson`, `JsonRepairError`, and the exported types `RepairOptions`, `RepairResult`, `Fix`, `FixKind`, `JsonRepairErrorCode`. It also holds the private parser `Repairer`. |

The package has one source module. Internal helpers are not re-exported.

## Boundaries

- No runtime dependencies. Development tooling is listed in [STACK.md](STACK.md).
- No `node:` imports in `src/`, so the code also runs in browsers.
- No I/O and no global state. Calls are deterministic.
- Input validation happens before parsing. Option and input type errors throw `TypeError`. Repair failures throw `JsonRepairError` with a stable `code` and an `offset`.
- Objects are built with `Object.defineProperty`, so a `__proto__` key becomes a plain own property.

## Parse flow

1. `repairJson` validates options and input, then checks length and emptiness.
2. `Repairer.run` skips a BOM, comments, code fences and prose until a value starts.
3. The main loop alternates between the states `value`, `element` and `after` until the root value closes.
4. Trailing text is recorded as `strip` fixes.
5. When no fix was recorded, the input is returned as `text`. Otherwise the value is serialised with `JSON.stringify`.

## Build and distribution

`npm run build` compiles `src/` to `dist/` with `tsconfig.build.json`. Only `dist/` is published (`files` in `package.json`).

## Decisions

Architectural decisions are recorded in [decisions/](decisions/), starting with [0001](decisions/0001-record-architecture-decisions.md).
