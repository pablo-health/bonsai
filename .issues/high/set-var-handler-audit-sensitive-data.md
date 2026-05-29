---
title: "SetVarHandler sensitive data in audit log and persistence before execution"
severity: high
status: resolved
created: 2026-05-29
updated: 2026-05-29
assignee: ""
tags: [security, audit-log, websocket]
---

# SetVarHandler sensitive data in audit log and persistence before execution

## Description

Multiple HIGH issues in `SetVarHandler.ts`:

1. **Line 38-39**: `saveCommandEvent` persists before `setVariable` executes. If setVariable fails, orphan command event recorded.
2. **Line 38**: `variableValue` persisted to audit log without sanitization. Secrets/PII recorded permanently.

## Steps to Reproduce

1. Set a variable with a sensitive value
2. Observe value persisted in plaintext in audit log

## Expected Behavior

Sensitive values should be redacted in audit logs. Events should only persist after successful execution.

## Actual Behavior

Values persisted in plaintext before execution completes.

## Notes

File: `src/channels/handlers/SetVarHandler.ts`
