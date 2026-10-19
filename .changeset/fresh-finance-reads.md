---
"@notsuhas/moneylover-kit": patch
---

Read current account data on every MCP call instead of retaining results for five minutes.

Rebuild mobile transaction snapshots from full server reads because incremental pulls can omit accepted writes. Migrate old snapshots and preserve resumable pagination.
