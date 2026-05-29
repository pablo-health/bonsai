---
title: "ConversationStorageService bare Error and orphaned uploads"
severity: high
status: open
created: 2026-05-29
updated: 2026-05-29
assignee: ""
tags: [error-handling, resource-leak]
---

# ConversationStorageService bare Error and orphaned uploads

## Description

Multiple HIGH issues in `ConversationStorageService.ts`:

1. **Line 176**: Throws bare `Error`. Breaks convention and error handler mapping.
2. **Line 44-62**: Orphaned storage. Upload succeeds but insert fails. No cleanup.

## Steps to Reproduce

1. Upload storage where DB insert fails
2. Observe orphaned file in storage

## Expected Behavior

Custom error classes. Atomic upload/insert with cleanup on failure.

## Actual Behavior

Bare Error throws. Orphaned files on DB failure.

## Notes

File: `src/services/ConversationStorageService.ts`
