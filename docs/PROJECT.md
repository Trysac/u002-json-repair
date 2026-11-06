# Project record: json-repair

## Objective

Repair truncated or malformed JSON returned by an LLM with a single-pass tolerant parser that reports every fix with its UTF-16 offset. The library has no runtime dependencies and runs in Node.js 20+ and in browsers.

The outcome is a result that carries the repaired value, the repaired text and the list of fixes, or a typed `JsonRepairError` with a stable code. The acceptance checks in the project specification define the expected results. The intended users are developers who parse LLM output in Node.js or browser code and need to know exactly what was changed.

## Scope

In scope:

- The public API documented in the README: `repairJson`, `tryRepairJson`, `JsonRepairError`, and the types `RepairOptions`, `RepairResult`, `Fix`, `FixKind`.
- Repair of truncation, prose, code fences, byte order marks, comments, trailing and missing commas, single quotes, unquoted keys, Python and non-finite literals, number normalisation, raw control characters, duplicate keys and `__proto__` keys.
- Limits on input length, nesting depth and number of fixes.

Out of scope:

- JSON5 and other extended JSON dialects beyond the listed repairs.
- Streaming input and incremental parsing.
- YAML and other formats.
- Schema validation of the repaired value.
- Sanitising strings or values for display or for execution.

## Timeline

| Date | Milestone |
|---|---|
| 2026 | Repository created from the factory utility template. |

## Effort metrics

Values come from the factory ledger and the time log. A cell stays at "pending measurement" until its figure is recorded.

| Metric | Value | Source |
|---|---|---|
| Tokens (input / output) | 323491 / 150281 | factory ledger |
| Hours (human) | pending measurement | time log |
| Cost (USD) | 0.9757 | factory ledger |

## Factory run u002b (measured from API usage)

| Phase | Model | Batch | Input | Output | Cache write | Cache read | Cost (USD) |
|---|---|---|---|---|---|---|---|
| generation | claude-sonnet-5-5 | yes | 2720 | 127581 | 0 | 4473 | 0.6411 |
| fix-1 | claude-sonnet-5-5 | no | 4 | 1087 | 8582 | 26356 | 0.0350 |
| fix-2 | claude-sonnet-5-5 | no | 8 | 1354 | 19595 | 67846 | 0.0693 |
| audit | claude-sonnet-5-5 | no | 12 | 6233 | 28255 | 124519 | 0.1454 |
| fix-3 | claude-sonnet-5-5 | no | 8 | 3728 | 13073 | 63966 | 0.0764 |
| docs | claude-haiku-5-5 | no | 33579 | 10298 | 0 | 0 | 0.0085 |

Total: $0.9757. Prices: Anthropic list prices.
