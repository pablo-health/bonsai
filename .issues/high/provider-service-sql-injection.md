---
title: "ProviderService SQL injection and unconditional field overwrites"
severity: high
status: resolved
created: 2026-05-29
updated: 2026-05-29
assignee: ""
tags: [security, sql-injection, data-integrity]
---

# ProviderService SQL injection and unconditional field overwrites

## Description

1. **Line 125**: Raw string interpolation for JSONB. SQL injection via user-controlled input. FIXED: parameterized with `sql.param()`.

Note: The original claim about "partial update overwrites with NULL" was incorrect. Drizzle filters out `undefined` values in `mapUpdateSet()`, so the original code was safe.

## Notes

File: `src/services/providers/ProviderService.ts`
