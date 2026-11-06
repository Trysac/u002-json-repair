# Security practices

How this repository keeps the package and its users safe. The disclosure policy is in [../SECURITY.md](../SECURITY.md).

## Threat model

The library parses untrusted text, usually the output of a language model. The threats below are the ones the code addresses, and the limits that remain.

Defended:

- Prototype pollution: members are created with `Object.defineProperty`, so a `__proto__` key becomes an own property and does not change `Object.prototype`.
- Stack exhaustion: parsing uses an explicit stack. Nesting deeper than `maxDepth` (default 512) throws `MAX_DEPTH`. Serialising a value that is too deep for `JSON.stringify` also throws `MAX_DEPTH`.
- Oversized input: input longer than `maxLength` (default 1,000,000 UTF-16 units) throws `INPUT_TOO_LARGE` before parsing.
- Fix flooding: more than `maxFixes` (default 10,000) fixes throws `TOO_MANY_FIXES`.
- Regular-expression backtracking: the regular expressions in `src/index.ts` are anchored and do not nest quantifiers over the same characters.
- Hostile escapes: an invalid escape or a malformed `\u` sequence throws `UNREPAIRABLE` instead of being guessed.

Not defended:

- Running time is not capped. Work grows with input length up to `maxLength`, and the caller decides the limit.
- Memory use is not capped separately. Input length, depth and fix count bound it only indirectly.
- Semantic changes are not detected. Completed literals, dropped dangling keys, `NaN` and `Infinity` written as `null`, and the kept last value of a duplicate key all change the meaning of the data. The fixes list reports these changes but does not reject them.
- Number precision is reported only when the text is rewritten. A value that is returned unchanged keeps the precision of its input text, and `value` still holds the rounded `Number`.
- The repaired value is untrusted data. The library does not validate its shape or content, so callers must validate it before use.
- Prose that starts with `{` or `[` is treated as the start of the value.

## Secrets

- No secrets, tokens or credentials in the repository, commit history, logs or prompts.
- `gitleaks` runs as the last step of `npm run check` and as a dedicated CI job. Its configuration is `.gitleaks.toml`.
- Publishing credentials live only in the CI secret store or the maintainer's local npm configuration.

## Dependencies

- The package has no runtime dependencies. Development dependencies are limited to the toolchain listed in [STACK.md](STACK.md).
- Dependabot opens weekly updates for npm packages and GitHub Actions.
- Commit the generated `package-lock.json` so installs are reproducible.

## Code

- No `eval`, dynamic `Function` construction or shelling out from library code.
- Inputs from callers are validated and rejected with explicit errors (`TypeError` for options and input types, `JsonRepairError` for repair failures).
- Error messages quote at most 40 characters of the input.

## Publishing

- Packages are published from a clean checkout after `npm run check` passes.
- Only `dist/` is included in the published tarball.
