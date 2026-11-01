---
"@notsuhas/moneylover-kit": patch
---

Harden MCP HTTP startup (one server per process, constant-time bearer check, graceful shutdown drain) and preserve the original error when SQLite rollback fails.
