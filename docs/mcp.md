# The MCP server

Eight tools over a live account. Two transports, same tools.

| Tool | Does |
|---|---|
| `list_wallets` | wallet names, and balances where the backend has them |
| `list_categories` | what can be written to, income or expense |
| `search_transactions` | filter by note, wallet, category, date range, amount |
| `add_transaction` | create one |
| `edit_transaction` | change named fields, preserve the rest |
| `delete_transaction` | remove one, permanently |
| `record_lending` | lend, collect, borrow or repay, against a person |
| `lending_summary` | net position per person, across wallets |

Those eight are always available. Wallet and category management is registered
only when `MONEYLOVER_MCP_ALLOW_STRUCTURE=1`:

| Tool | Does |
|---|---|
| `list_currencies_hint` | the numeric currency ids in use, for `add_wallet` |
| `add_wallet` · `edit_wallet` · `delete_wallet` | manage accounts |
| `add_category` · `edit_category` · `delete_category` | manage categories, including all-wallet and nested ones |

They are off by default deliberately. These reshape the account rather than
record something that happened, and `delete_wallet` takes every transaction in
that wallet with it — not a blast radius you want reachable from the internet
by default.

## Local — Claude Desktop, Cursor, Claude Code

```json
{
  "mcpServers": {
    "moneylover": {
      "command": "npx",
      "args": ["-y", "-p", "moneylover-kit", "moneylover-mcp"],
      "env": {
        "MONEYLOVER_EMAIL": "you@example.com",
        "MONEYLOVER_PASSWORD": "…"
      }
    }
  }
}
```

Config lives at:

- **Claude Desktop**, macOS —
  `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Claude Desktop**, Windows — `%APPDATA%\Claude\claude_desktop_config.json`
- **Claude Code** — `claude mcp add`
- **Cursor** — `~/.cursor/mcp.json`

Run `moneylover login` once first. Then the server reuses the cached token and
never logs in on its own, which is what keeps it from consuming device slots
every time your client restarts it.

If you would rather not put a password in a config file, log in once and pass
`MONEYLOVER_ACCESS_TOKEN` instead.

## Remote — streamable HTTP

```bash
export MONEYLOVER_EMAIL="you@example.com"
export MONEYLOVER_PASSWORD="…"
export MCP_TOKEN="$(openssl rand -hex 32)"

moneylover-mcp-http        # POST /mcp, GET /health, port 8790
```

`MCP_TOKEN` is required and the server refuses to start without it. Clients send
`Authorization: Bearer $MCP_TOKEN`.

| | |
|---|---|
| `MCP_TOKEN` | required; the bearer token clients must send |
| `MCP_PORT` | default `8790` |
| `MCP_HOST` | default `0.0.0.0` |

The transport is stateless — a fresh server per request, no session table — so
it restarts cleanly and sits behind a proxy or load balancer without
coordination.

### Exposing it safely

This endpoint can create and delete transactions in a real financial account.
If you put it on the internet:

- Terminate TLS in front of it. The bearer token is the only thing between a
  passer-by and your data.
- Prefer a private network — a VPN or a tunnel — over a public port. If it must
  be public, put it behind a reverse proxy you already trust.
- Give each client its own deployment rather than sharing one token widely.
  There is no per-client scoping here.
- `GET /health` is unauthenticated and returns only `ok`, so it is safe for a
  load-balancer probe.

## Working with it

Some things worth telling your agent, most of which the server already says in
its own instructions:

**Amounts are signed.** `-480` spent, `4500` earned. A sign that disagrees with
the category is rejected rather than corrected, so an error here means the
category was wrong, not the number.

**Deletes are permanent.** There is no undo and no trash. The tool description
asks for confirmation first; in a client that supports per-tool approval, put
`delete_transaction` behind one.

**Editing is a patch at this layer only.** The underlying API replaces the whole
row, so this re-reads and rebuilds it. That means an edit is safe, but it is
also two round trips — don't loop it over hundreds of rows.

**Reads are cached for a minute**, and writes invalidate the cache. So a search
immediately after an edit reflects the edit, but a change made in the phone app
may take up to a minute to show up.

## Troubleshooting

**Everything returns `token_device_not_found`.** This device is no longer on the
account — it was removed from the device list, here or in the app. Run
`moneylover login` to register a new one.

**A login fails with "maximum device limit reached".** Every slot is in use. Log
out of a device you no longer need, in the app or on the web, then retry.

**`add_transaction` hangs, then times out.** A category id the API rejected; it
hangs rather than erroring. Check the category name with `list_categories`.

**Empty results that shouldn't be empty.** A missing auth header returns
`error: 0` with no rows rather than a failure. Try `moneylover whoami` to
confirm the token is actually being sent.

**`lending_summary` shows a person twice.** `"Sam"` and `"Sam Fielding"` are
two different tags in your data. Nothing canonicalises them, and merging them
automatically would be a guess.
