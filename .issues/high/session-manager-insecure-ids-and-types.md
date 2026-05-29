---
title: "SessionManager insecure session IDs and type violations"
severity: high
status: open
created: 2026-05-29
updated: 2026-05-29
assignee: ""
tags: [security, type-safety, channels]
---

# SessionManager insecure session IDs and type violations

## Description

Multiple HIGH issues in `SessionManager.ts`:

1. **Line 65**: Session ID uses `Math.random()` — not cryptographically secure, ~7.8 trillion values. Use `crypto.randomUUID()`.
2. **Line 65**: `substr` is deprecated. Use `substring`.
3. **Line 68**: `projectId: null` assigned but type is `string`. Runtime values violate declared Session type.
4. **Lines 117-128**: `attachConversationToSession` doesn't clean up existing runner. Old runner abandoned.
5. **Lines 124-125**: Dynamic import + `container.resolve(ConversationRunner)` — if singleton, all sessions share runner. Cross-session corruption.
6. **Lines 135-143, 151-158**: `detachConversationFromSession` clears runner without calling `runner.cleanup()`. Resource leak.
7. **Lines 68-69, 141-142, 154-155**: `projectId`/`conversationId` typed as `string` but assigned `null`. Type violation.

## Steps to Reproduce

1. Create many sessions and observe ID collision probability
2. Attach a conversation to a session that already has a runner
3. Observe old runner abandoned without cleanup

## Expected Behavior

Cryptographically secure session IDs. Proper type assignments. Runner cleanup on detach.

## Actual Behavior

Insecure IDs. Type violations. Resource leaks from abandoned runners.

## Notes

File: `src/channels/SessionManager.ts`
