---
title: "Knowledge base FAQ entries not passed to prompt builder"
severity: medium
status: open
created: 2026-06-01
updated: 2026-06-01
assignee: ""
tags: [bug, investigation-needed]
---

# Knowledge base FAQ entries not passed to prompt builder

## Description

Knowledge base related answers are not being retrieved. A quick investigation using `console.log()` showed that no FAQ entries were going to the prompt builder/renderer. The root cause was not identified.

## Steps to Reproduce

1. Set up a project with knowledge base FAQ entries
2. Trigger a conversation that should use knowledge base answers
3. Observe that no FAQ entries reach the prompt builder

## Expected Behavior

FAQ entries from the knowledge base are included in the prompt builder/renderer.

## Actual Behavior

No FAQ entries are passed to the prompt builder/renderer.

## Notes

Not 100% certain this is a bug — could be a project misconfiguration. Further investigation needed to determine whether the issue is in the backend logic or in how the project is configured.
