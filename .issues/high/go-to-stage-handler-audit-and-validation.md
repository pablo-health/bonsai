---
title: "GoToStageHandler audit log before execution and missing validation"
severity: high
status: open
created: 2026-05-29
updated: 2026-05-29
assignee: ""
tags: [audit-log, validation, websocket]
---

# GoToStageHandler audit log before execution and missing validation

## Description

Multiple HIGH issues in `GoToStageHandler.ts`:

1. **Line 38-39**: `saveCommandEvent` persists before `goToStage` executes. If goToStage throws, audit log records command that never completed.
2. **Line 39**: No validation that `stageId` is non-empty. Empty string passes through.

## Steps to Reproduce

1. Send a go_to_stage message with empty stageId
2. Observe no validation, empty string passes through

## Expected Behavior

Stage ID should be validated before execution. Audit events should only persist after success.

## Actual Behavior

Empty stage ID passes through. Audit event persisted before execution.

## Notes

File: `src/channels/handlers/GoToStageHandler.ts`
