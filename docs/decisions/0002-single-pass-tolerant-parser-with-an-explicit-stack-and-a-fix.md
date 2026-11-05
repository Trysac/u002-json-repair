# Single-pass tolerant parser with an explicit stack and a fix report

Status: accepted (generated, pending human review)

## Context

LLM output is often truncated or malformed JSON. Regex-based repair rewrites string contents, recursive repair overflows the call stack on hostile nesting, and assigning keys such as __proto__ can reach the prototype. Callers also need to know what changed so they can reject risky repairs, and the code must run in browsers without node: imports.

## Decision

Implement one tolerant pass over the input with an explicit frame stack and a small state machine (value, afterValue, key, colon, done). Depth is bounded by maxDepth and input size by maxLength. Members are created with Object.defineProperty. Every repair is recorded as a Fix of one of ten kinds with a UTF-16 offset; fixes are sorted by offset. With zero fixes the original text is returned, otherwise compact JSON.stringify of the value, which makes repair idempotent. Invalid escape sequences are rejected instead of guessed, and options that are invalid fall back to defaults so tryRepairJson never throws.

## Consequences

Repair is linear in input size, immune to stack overflow, prototype-safe and fully auditable through the fix list. Some imperfect inputs (unescaped quotes inside strings, invalid escapes, truncated literals such as tru) are reported as UNREPAIRABLE rather than guessed. Serializing an extremely deep value with a very large maxDepth may still hit the engine limit and is reported as MAX_DEPTH.
