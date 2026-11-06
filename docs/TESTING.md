# Testing

## Tools

- [Vitest](https://vitest.dev/) runs the suites in `test/`.
- Coverage is collected with V8 (`@vitest/coverage-v8`) over `src/`.

## Test files

- `test/index.test.ts` covers the public API in these groups: truncation (closing containers and strings, dangling keys, partial escapes, refused truncation); tolerant syntax (quotes, literals, comments, trailing and missing commas, number normalisation, control characters, escapes and lone surrogates, rejected structures); prose, code fences and byte order marks; objects (`__proto__`, duplicate keys); numbers (lossy re-serialisation reporting); limits and options (`maxDepth`, `maxLength`, `maxFixes`, option type errors, message length); and idempotence and properties (valid JSON returned untouched, repaired text is a fixed point, every prefix of a sample document is repaired or rejected, 3000 seeded random garbage strings only produce `JsonRepairError`, 200 seeded random documents round-trip with no fixes).
- `test/acceptance-literals.test.ts` holds acceptance checks for the behaviour listed in the project specification: the example repairs, the error codes for depth, size and empty input, prose handling and fix kinds. Its test titles are partial sentences.

## Commands

```sh
npm test            # vitest run --coverage
npx vitest          # watch mode while developing
npm run check       # every gate, including tests
```

## Rules

- Coverage must stay at or above 80 % for lines, branches, functions and statements (`vitest.config.ts`). Lowering the thresholds is not allowed.
- Tests go through the public entry point (`src/index.ts`) and assert observable behavior: return values, thrown errors and their messages.
- Each bug fix adds a test that fails without the fix.
- Tests are deterministic: no network, no real clock, randomness only from a fixed seed, and no shared state between tests.

## Reports

Coverage reports are written to `coverage/` (text summary and `lcov`). The folder is ignored by git.
