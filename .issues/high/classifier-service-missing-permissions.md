---
title: "ClassifierService missing permission checks and extra DB queries"
severity: high
status: open
created: 2026-05-29
updated: 2026-05-29
assignee: ""
tags: [security, performance]
---

# ClassifierService missing permission checks and extra DB queries

## Description

Multiple HIGH issues in `ClassifierService.ts`:

1. **Lines 63/279**: `getClassifierById` and `getClassifierAuditLogs` have no permission checks.
2. **Lines 73/140**: Separate `isProjectActive()` query adds extra round-trip per read.

## Steps to Reproduce

1. Call getClassifierById without proper permissions
2. Observe no permission enforcement

## Expected Behavior

Permission checks on all read operations. Combined queries for active status.

## Actual Behavior

Missing permission checks. Extra DB round-trips.

## Notes

File: `src/services/ClassifierService.ts`
