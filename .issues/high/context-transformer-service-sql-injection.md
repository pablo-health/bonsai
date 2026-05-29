---
title: "ContextTransformerService SQL injection and missing permissions"
severity: high
status: resolved
created: 2026-05-29
updated: 2026-05-29
assignee: ""
tags: [security, sql-injection]
---

# ContextTransformerService SQL injection and missing permissions

## Description

Multiple HIGH issues in `ContextTransformerService.ts`:

1. **Line 110**: SQL injection via `JSON.stringify(tagsArray)`.
2. **Line 280**: `getContextTransformerAuditLogs` no permission check, no project access.

## Steps to Reproduce

1. Create/update transformer with malicious tags
2. Observe SQL injection vulnerability

## Expected Behavior

Tags should be parameterized. Permission checks on audit logs.

## Actual Behavior

SQL injection via tags. Missing permissions on audit access.

## Notes

File: `src/services/ContextTransformerService.ts`
