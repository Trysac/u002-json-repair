# Project record: json-repair

## Objective

Repair truncated or malformed JSON returned by an LLM with an iterative tolerant parser and an offset-annotated report of every fix, zero dependencies

State the measurable outcome this utility must deliver and who it is for.

## Scope

In scope:

- The public API documented in the README.

Out of scope:

- List what this utility deliberately does not do.

## Timeline

| Date | Milestone |
|---|---|
| 2026 | Repository created from the factory utility template. |

## Effort metrics

Measured values only. Leave "pending measurement" until a real figure is recorded; never estimate here.

| Metric | Value | Source |
|---|---|---|
| Tokens (input / output) | pending measurement | factory ledger |
| Hours (human) | pending measurement | time log |
| Cost (USD) | pending measurement | factory ledger |

## Factory run u002 (measured from API usage)

| Phase | Model | Batch | Input | Output | Cache write | Cache read | Cost (USD) |
|---|---|---|---|---|---|---|---|
| generation | claude-sonnet-5-5 | yes | 2066 | 48000 | 4194 | 0 | 0.2505 |
| generation | claude-sonnet-5-5 | yes | 2066 | 89887 | 0 | 4194 | 0.4519 |
| fix-1 | claude-sonnet-5-5 | no | 6 | 2839 | 20842 | 34329 | 0.0839 |
| fix-2 | claude-sonnet-5-5 | no | 6 | 3093 | 14565 | 47273 | 0.0721 |
| docs | claude-haiku-5-5 | no | 25426 | 3140 | 0 | 0 | 0.0041 |

Total: $0.8625. Prices: Anthropic list prices.
