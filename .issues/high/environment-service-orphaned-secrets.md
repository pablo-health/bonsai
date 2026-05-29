---
title: "EnvironmentService orphaned secrets on DB failure"
severity: high
status: open
created: 2026-05-29
updated: 2026-05-29
assignee: ""
tags: [security, data-integrity]
---

# EnvironmentService orphaned secrets on DB failure

## Description

Multiple HIGH issues in `EnvironmentService.ts`:

1. **Line 46-47**: Orphaned secret on DB failure. `storeSecret()` succeeds but `db.insert()` fails. Secret stored in vault but no DB record.
2. **Line 182**: Same orphaned secret issue. `storeSecret()` succeeds but `db.update()` fails.

## Steps to Reproduce

1. Create/update environment variable where DB write fails after secret is stored
2. Observe secret in vault with no corresponding DB record

## Expected Behavior

Atomic operation: either both succeed or both roll back.

## Actual Behavior

Secret stored in vault but DB record fails, leaving orphaned secret.

## Notes

File: `src/services/EnvironmentService.ts`
