---
title: "MigrationService plain-text credentials and argument bugs"
severity: high
status: open
created: 2026-05-29
updated: 2026-05-29
assignee: ""
tags: [security, data-integrity]
---

# MigrationService plain-text credentials and argument bugs

## Description

Multiple HIGH issues in `MigrationService.ts`:

1. **Line 117**: `resolveBundle` called with `selection` as both first and third argument.
2. **Line 181-199**: Audit logging async. Failed audit swallowed.
3. **Line 259/784**: Plain-text credentials over HTTP. No protocol enforcement.
4. **Line 306**: `runPull` fire-and-forget. Stuck on process exit.
5. **Line 354**: `resolveBundle` with empty string hash. Inconsistent.

## Steps to Reproduce

1. Run migration with HTTP endpoint
2. Observe credentials transmitted in plaintext

## Expected Behavior

HTTPS-only. Proper argument passing. Synchronous audit logging.

## Actual Behavior

Plaintext credentials. Wrong arguments. Fire-and-forget operations.

## Notes

File: `src/services/MigrationService.ts`
