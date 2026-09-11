# Changelog

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
