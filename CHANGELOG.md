# Changelog

## 0.3.1

### Patch Changes

- Round wallet balances after summing split legs, and detach obsolete loan links
  when a collection is corrected to borrowing.

## 0.3.0

### Minor Changes

- Add record_transactions to check duplicate receipts, batch personal and
  lending or borrowing entries in one push, and verify fresh saved records and
  wallet balances. Persist private idempotency journals and stop uncertain or
  partial writes from being retried blindly.
- Add targeted saved-record lookup and explicit cross-currency loan collection
  using both actual amounts, linked collection and excluded system transfer
  legs.

## 0.2.3

### Patch Changes

- Resolve wallet names and currencies without downloading transaction history
  during expense writes and rendering. Keep full reconciliation for transaction
  checks and balance requests.

## 0.2.2

### Patch Changes

- cd7da7b: Reuse one fresh snapshot within a single MCP operation, avoiding
  repeated full account downloads during edits while keeping consecutive tool
  calls fresh.

  Retain receipt UTC offsets in namespaced metadata so early-morning purchases
  keep the intended calendar day after API timestamp normalization.

## 0.2.1

### Patch Changes

- d4ca9a8: Read current account data on every MCP call instead of retaining
  results for five minutes.

  Rebuild mobile transaction snapshots from full server reads because
  incremental pulls can omit accepted writes. Migrate old snapshots and preserve
  resumable pagination.

## 0.2.0

### Minor Changes

- b214a15: Record exact receipt times using an optional dateTime timestamp with
  an explicit UTC offset in MCP tools, the client and CLI. Preserve existing
  timestamps on unrelated edits and return them in tool results.

## 0.1.6

### Patch Changes

- Expose event lookup and tagging through MCP transaction and lending tools.

## 0.1.5

### Patch Changes

- Collect part of a specific loan into any active wallet in the same currency,
  and preserve the loan link when editing or deleting collections.

## 0.1.4

### Patch Changes

- Use one persistent mobile sync for every read and write, including exact
  balances and wallet create, edit and delete.
- Refresh and resume automatically without falling back to a web login.

## 0.1.3

### Patch Changes

- Refresh mobile tokens without registering another device.

## 0.1.2

### Patch Changes

- Retry reads immediately after a temporary cached load failure.

## 0.1.1

### Patch Changes

- Add event creation to the TypeScript client and opt-in MCP structure tools.

## 0.1.0 — 2026-09-11

First release.

- Client for both Money Lover APIs — web (default) and mobile — with scriptable
  password login on each, and an on-disk token cache so a login happens once
  rather than per process.
- Full transaction CRUD. Updates and deletes are new to this ecosystem: the wire
  format is a full replace, so every write is rebuilt from the live row and an
  edit changes only the fields you name.
- Lending: `lend`, `collect`, `borrow`, `repay`, and a net position per person
  across wallets, resolved through Money Lover's own system categories.
- CLI (`moneylover`) and MCP server over stdio (`moneylover-mcp`) and streamable
  HTTP (`moneylover-mcp-http`).
- Documented both APIs, including the traps: the category id that hangs for 120
  seconds instead of erroring, the four response shapes, and the device limit.
- Wallet and category management, off by default behind
  `MONEYLOVER_MCP_ALLOW_STRUCTURE`, with deleting one gated separately again
  behind `MONEYLOVER_MCP_ALLOW_DELETE`.
