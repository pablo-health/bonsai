---
title: "messages.ts schema inconsistencies and JSON incompatibility"
severity: high
status: open
created: 2026-05-29
updated: 2026-05-29
assignee: ""
tags: [type-safety, serialization, websocket]
---

# messages.ts schema inconsistencies and JSON incompatibility

## Description

Multiple HIGH issues in `messages.ts`:

1. **Line 251**: `calSetVarResponseSchema` uses `type: 'set_var_result'` while request uses `type: 'set_var'`. Inconsistency can break client-side message correlation.
2. **Lines 317, 389, 400**: `z.instanceof(Buffer)` makes schema incompatible with JSON serialization.

## Steps to Reproduce

1. Attempt to JSON-serialize a message with Buffer field
2. Observe serialization failure or data loss

## Expected Behavior

Schemas should be JSON-compatible. Response type discriminators should be consistent.

## Actual Behavior

Buffer schemas break JSON serialization. Inconsistent type naming.

## Notes

File: `src/channels/messages.ts`
