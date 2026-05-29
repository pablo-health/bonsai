---
title: "BenchmarkExecutorService N+1 queries and race conditions"
severity: high
status: open
created: 2026-05-29
updated: 2026-05-29
assignee: ""
tags: [performance, race-condition]
---

# BenchmarkExecutorService N+1 queries and race conditions

## Description

Multiple HIGH issues in `BenchmarkExecutorService.ts`:

1. **Line 116**: No `orderBy` on pending run selection. Race condition across processes.
2. **Line 124**: No `orderBy` on config selection. Non-deterministic order.
3. **Line 147-151**: N+1 query. 2 queries per config. Should batch.

## Steps to Reproduce

1. Run benchmark with multiple configs
2. Observe N+1 query pattern

## Expected Behavior

Deterministic ordering. Batched queries.

## Actual Behavior

Race conditions. N+1 queries.

## Notes

File: `src/services/BenchmarkExecutorService.ts`
