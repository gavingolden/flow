# PR #1: feat: add cart bulk-discount tier

**URL:** https://github.com/example-org/example-repo/pull/1
**Branch:** `feature-1`
**State:** OPEN
**Stats:** +40 −10 across 2 files

## Description

## Why

Spend-based bulk discount tiers were requested by sales.

## What

Adds the pricing tier and tests.

## Test Steps

- [x] Run `npm run test` — all specs pass.

## Changed Files

- `src/pricing.ts`
- `src/pricing.test.ts`

## Inline Comments (2)

### `src/pricing.ts`

#### L5 — @reviewer-a
**Comment ID:** 1002

nit: keep the tier constants in one table like the rest of this module.

#### L12 — @reviewer-a
**Comment ID:** 1001

This threshold comparison looks off by one: a cart of exactly 100 should qualify.
