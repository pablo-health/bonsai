---
title: "BenchmarkService dangling FKs and orphaned configs"
severity: high
status: open
created: 2026-05-29
updated: 2026-05-29
assignee: ""
tags: [data-integrity, resource-leak]
---

# BenchmarkService dangling FKs and orphaned configs

## Description

Multiple HIGH issues in `BenchmarkService.ts`:

1. **Line 234-243**: `createConfig` doesn't validate `providerConfigId`. Dangling FK.
2. **Line 87-95**: `deleteSuite` doesn't delete/check `benchmarkConfigs`. Orphaned configs.
3. **Line 93-94**: Delete before `refreshSuiteSchedule`. Cron race.

## Steps to Reproduce

1. Create a benchmark config with invalid providerConfigId
2. Observe dangling foreign key

## Expected Behavior

FK validation. Cascade deletes. Proper operation ordering.

## Actual Behavior

Dangling FKs. Orphaned configs. Cron race on delete.

## Notes

File: `src/services/BenchmarkService.ts`
