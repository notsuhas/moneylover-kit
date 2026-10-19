---
"@notsuhas/moneylover-kit": patch
---

Reuse one fresh snapshot within a single MCP operation, avoiding repeated full account downloads during edits while keeping consecutive tool calls fresh.

Retain receipt UTC offsets in namespaced metadata so early-morning purchases keep the intended calendar day after API timestamp normalization.
