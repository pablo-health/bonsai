---
title: "ConversationTimeoutService unbounded queries and no shutdown hook"
severity: high
status: open
created: 2026-05-29
updated: 2026-05-29
assignee: ""
tags: [resource-leak, crash]
---

# ConversationTimeoutService unbounded queries and no shutdown hook

## Description

Multiple HIGH issues in `ConversationTimeoutService.ts`:

1. **Line 33**: Cron handle never stored. No way to stop on shutdown.
2. **Line 74-76**: No concurrency guard. Double-abort risk.
3. **Line 82-85**: Likely duplicate event persistence.

## Steps to Reproduce

1. Shut down the server
2. Observe cron job continues running

## Expected Behavior

Cron should stop on shutdown. Concurrency guards on abort. Single event persistence.

## Actual Behavior

Cron runs after shutdown. Double aborts. Duplicate events.

## Notes

File: `src/services/ConversationTimeoutService.ts`
