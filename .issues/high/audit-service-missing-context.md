---
title: "AuditService missing RequestContext and crash on empty results"
severity: high
status: open
created: 2026-05-29
updated: 2026-05-29
assignee: ""
tags: [security, crash, audit]
---

# AuditService missing RequestContext and crash on empty results

## Description

Multiple HIGH issues in `AuditService.ts`:

1. **Line 56**: `auditLog[0]` crashes if `.returning()` returns empty array. No guard.
2. **Lines 33/80/108/138**: No `RequestContext` parameter. Bypasses defense-in-depth security pattern.

## Steps to Reproduce

1. Call audit method where `.returning()` returns empty array
2. Observe crash on array index access

## Expected Behavior

Array access should be guarded. All service methods should accept RequestContext.

## Actual Behavior

Crash on empty results. Missing context bypasses security pattern.

## Notes

File: `src/services/AuditService.ts`
