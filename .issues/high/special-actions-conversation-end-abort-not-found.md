---
title: "Special actions __conversation_end and __conversation_abort not found"
severity: high
status: open
created: 2026-06-01
updated: 2026-06-01
assignee: ""
tags: [bug]
---

# Special actions __conversation_end and __conversation_abort not found

## Description

Triggering special conversation actions (`__conversation_end`, `__conversation_abort`) fails with "Action not found" errors, even though the actions exist in the project. The issue appears to affect only special actions, not regular ones.

## Steps to Reproduce

1. Add a `__conversation_end` or `__conversation_abort` action to a project
2. Trigger the action during a conversation
3. Observe the error in logs

## Expected Behavior

The special action executes successfully.

## Actual Behavior

The following errors are logged:

```
[2026-06-01 16:02:41.958 +0200] ERROR: Failed to run action
    sessionId: "session_9528290d-3232-46be-b357-057b4504e5c8"
    conversationId: "conv_019e837e-0efd-70b8-b806-00bdf8aec846"
    actionName: "__conversation_end"
    error: "Action __conversation_end not found in project proj_019e832b-270c-7073-90dc-a52881271b0d"
```

```
[2026-06-01 16:09:23.317 +0200] ERROR: Failed to run action
    sessionId: "session_209aae51-3b97-4f4d-b655-59f095d8655d"
    conversationId: "conv_019e8384-59d0-74fe-a1e8-5b75651fc179"
    actionName: "__conversation_abort"
    error: "Action __conversation_abort not found in project proj_019e832b-270c-7073-90dc-a52881271b0d"
```

## Notes

The action with the given name exists in the project (confirmed via screenshot). Problem appears isolated to special actions (those prefixed with `__`).
