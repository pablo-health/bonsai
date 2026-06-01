---
title: "Resuming conversation fails with NotFoundError due to empty conversationId"
severity: high
status: resolved
created: 2026-06-01
updated: 2026-06-01
assignee: ""
tags: [bug]
---

# Resuming conversation fails with NotFoundError due to empty conversationId

## Description

Resuming a conversation results in a NotFoundError because the `conversationId` is an empty string. The error originates from `ConversationService.getConversationById` being called with an empty id.

## Steps to Reproduce

1. Attempt to resume a conversation
2. Observe the error in logs

## Expected Behavior

The conversation resumes successfully with the correct conversation ID.

## Actual Behavior

The following error is logged:

```
[2026-06-01 15:32:27.777 +0200] ERROR: Failed to fetch conversation
    conversationId: ""
    error: {
      "type": "NotFoundError",
      "message": "Conversation with id  not found",
      "stack":
          NotFoundError: Conversation with id  not found
              at ConversationService.getConversationById (X:\repos-utter.one\nexus-backend\src\services\ConversationService.ts:269:15)
              at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
              at async ResumeConversationHandler.handle (X:\repos-utter.one\nexus-backend\src\channels\handlers\ResumeConversationHandler.ts:38:26)
              at async ChannelHandlerDispatcher.dispatch (X:\repos-utter.one\nexus-backend\src\channels\ChannelHandlerDispatcher.ts:93:7)
              at async WebSocketChannelHost.handleMessage (X:\repos-utter.one\nexus-backend\src\channels\websocket\WebSocketChannelHost.ts:167:5)
      "name": "NotFoundError"
    }
```

## Notes

Stack trace points to `ResumeConversationHandler.ts:38` passing an empty `conversationId` to `ConversationService.getConversationById`. This may be a frontend issue.
