---
title: "ConversationService missing permissions and type violations"
severity: high
status: open
created: 2026-05-29
updated: 2026-05-29
assignee: ""
tags: [security, type-safety]
---

# ConversationService missing permissions and type violations

## Description

Multiple HIGH issues in `ConversationService.ts`:

1. **Line 187**: `setConversationMetadata` no permission check or `requireProjectNotArchived`.
2. **Line 205/219**: `updateConversationEventMetadata` returns `undefined` on catch instead of `null`. Type violation.
3. **Line 232/251**: `updateMessageEvent` returns `undefined` on catch instead of `null`. Type violation.
4. **Line 56**: `context` optional for write op. Missing permission check.

## Steps to Reproduce

1. Call setConversationMetadata without proper permissions
2. Observe no permission enforcement

## Expected Behavior

Permission checks on all write operations. Consistent return types.

## Actual Behavior

Missing permissions. Type violations on error paths.

## Notes

File: `src/services/ConversationService.ts`
