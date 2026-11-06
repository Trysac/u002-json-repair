# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries are derived from Conventional Commits.

## [Unreleased]

### Added

- Add `repairJson` and `tryRepairJson`: an iterative, zero-dependency tolerant JSON parser that repairs truncated or malformed LLM output and returns the value, the repaired text and an offset-annotated list of every fix, with typed `JsonRepairError` codes and limits on length, depth and fixes.
- Initial project structure from the factory utility template.
