# Single-pass tolerant parser with an explicit stack and a fix ledger

Status: accepted (generated, pending human review)

## Context

LLM output is often truncated, wrapped in prose or written with comments, trailing commas, single quotes and Python or NaN literals. Regex rewriting of strings is unsafe, recursive parsers overflow the stack on hostile nesting, and assigning keys with plain property syntax lets a __proto__ key reach the prototype. Callers also need to know what was changed so they can reject risky repairs, which a string-only result does not allow.

## Decision

Implement one tolerant parser as a state machine over an explicit stack of frames, with three states (value, element, after) and no recursion, so nesting is bounded by maxDepth. Every repair is recorded as a frozen Fix with a kind, a UTF-16 offset and a detail, then the fixes are sorted by offset. Objects are built with Object.defineProperty so __proto__ is an own property, and duplicate names keep the last value and are reported. When no fix was needed the input is returned unchanged as text; otherwise the value is re-serialised, and only then are lossy number conversions reported. Input length, nesting depth and fix count each have a named limit that raises the typed JsonRepairError.

## Consequences

Hostile input cannot overflow the stack or pollute prototypes, and every change is auditable by offset. The parser is deliberately conservative: ambiguous input such as a sign without digits, an unknown escape or glued tokens is UNREPAIRABLE rather than guessed. Serialising a value nested deeper than the engine allows can still overflow in JSON.stringify, so that failure is mapped to MAX_DEPTH. Features such as JSON5 and streaming are out of scope and would need a different design.
