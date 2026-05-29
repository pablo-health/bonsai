---
title: "AuthService login by UUID instead of email and token validation gaps"
severity: high
status: open
created: 2026-05-29
updated: 2026-05-29
assignee: ""
tags: [security, authentication]
---

# AuthService login by UUID instead of email and token validation gaps

## Description

`AuthService.ts` line 93: Login looks up operator by `id` parameter. JSDoc says email, but queries by UUID. This is a security concern as UUIDs may be enumerable or exposed elsewhere.

## Steps to Reproduce

1. Attempt login with email
2. Observe lookup by UUID instead

## Expected Behavior

Login should look up by email as documented.

## Actual Behavior

Lookup by UUID, contradicting documentation.

## Notes

File: `src/services/AuthService.ts`
