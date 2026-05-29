---
title: "ProviderService SQL injection and unconditional field overwrites"
severity: high
status: open
created: 2026-05-29
updated: 2026-05-29
assignee: ""
tags: [security, sql-injection, data-integrity]
---

# ProviderService SQL injection and unconditional field overwrites

## Description

Multiple HIGH issues in `ProviderService.ts`:

1. **Line 125**: Raw string interpolation for JSONB. SQL injection via user-controlled input.
2. **Line 192-201**: `updatePayload` sets all fields unconditionally. Partial update overwrites with NULL.

## Steps to Reproduce

1. Update a provider with partial data
2. Observe existing fields overwritten with NULL

## Expected Behavior

Parameterized queries. Partial updates should only touch provided fields.

## Actual Behavior

SQL injection via config. All fields overwritten on update.

## Notes

File: `src/services/providers/ProviderService.ts`
