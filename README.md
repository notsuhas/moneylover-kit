# moneylover-kit

Unofficial [Money Lover](https://moneylover.me) client, CLI and MCP server. Full
transaction CRUD, lending, and a documented API — from your email and password,
with nothing else to set up.

Not affiliated with Money Lover or Finsify. Money Lover has no public API; this
talks to the same endpoints its own apps use.

## Why this exists

Other Money Lover clients can create and read transactions. None of them can
**update** or **delete** one, because the wire format is a full replace — a
naive edit silently wipes the people, the event, the exclude-from-report flag
and the reminder attached to the row. This rebuilds every write from the live
row, so an edit changes only what you asked it to.

It also documents the parts that cost real time to work out: why a wrong
category id hangs for two minutes instead of erroring, why an empty result isn't
an empty account, and why logging in twice can sign you out of your own phone.
See [docs/traps.md](docs/traps.md).

## Install

```bash
npm install -g moneylover-kit    # or npx moneylover-kit
```

Then set your credentials:

```bash
export MONEYLOVER_EMAIL="you@example.com"
export MONEYLOVER_PASSWORD="…"
```

## CLI

```bash
moneylover login                 # once — mints and caches a token
moneylover wallets               # names and balances
moneylover categories            # what you can write to
moneylover list --note coffee --from 2026-01-01 --limit 10

moneylover add  --wallet Cash --category Groceries --amount -480 --note "DMart"
moneylover edit <id> --note "DMart, cleaning supplies"
moneylover rm   <id>
```

Wallets and categories too:

```bash
moneylover add-wallet   --name Travel --currency 11
moneylover add-category --name Supplements --all-wallets --parent "Health"
moneylover edit-category --category Supplements --name Vitamins
moneylover rm-category  --category Vitamins
```

`--all-wallets` and `--parent` need `--backend mobile`: a category that spans
every wallet, or nests under another, lives in a layer the web API doesn't
model.

Amounts are **signed**: `-480` is spent, `4500` is earned. Money Lover stores
the direction in the category rather than the amount, so a sign that disagrees
with the category is rejected instead of quietly corrected.

`--json` on any command gives machine-readable output.

### Lending

Money Lover tracks money between people in four of its own system categories.
This wraps them, so the app's debt view sees what you record:

```bash
moneylover lend    --person Sam --amount 5000 --wallet Savings
moneylover collect --person Sam --amount 3000 --wallet Current
moneylover lending
```

```
person                          lent   collected   outstanding     you owe
Sam                          5000.00     3000.00       2000.00        0.00
Jordan                        800.00      800.00          0.00      450.00
```

The wallet is per leg, so lending from one account and being paid back into a
different one is normal — the balance is tracked against the **person**, not the
account. `borrow` and `repay` are the mirror for money you owe.

## MCP server

Two transports. Both expose the same eight tools: `list_wallets`,
`list_categories`, `search_transactions`, `add_transaction`, `edit_transaction`,
`delete_transaction`, `record_lending`, `lending_summary`.

**Local, for Claude Desktop / Cursor** — add to your MCP config:

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

**Remote, over HTTP** — for running it somewhere and pointing a client at it:

```bash
MCP_TOKEN=$(openssl rand -hex 32) moneylover-mcp-http   # POST /mcp, GET /health
```

It refuses to start without `MCP_TOKEN`. This endpoint can create and delete
transactions in a real account; an unauthenticated port is never the right
default.

Full setup notes, including how to keep an agent from doing something
irreversible: [docs/mcp.md](docs/mcp.md).

## Library

```ts
import { createClient } from "moneylover-kit";

const ml = createClient();

await ml.wallets();
await ml.transactions({ note: "coffee", from: "2026-01-01" });
await ml.addTransaction({
  wallet: "Cash",
  category: "Groceries",
  amount: -480,
});
await ml.lending("Sam");
```

The CLI and the MCP server are both thin layers over this, so they cannot do
anything the library can't.

## Two backends

|                                | `web` (default)                     | `mobile`                          |
| ------------------------------ | ----------------------------------- | --------------------------------- |
| Setup                          | email + password                    | also needs the app's OAuth client |
| Wallet balances                | **yes**                             | no                                |
| Writes                         | work, with a wrong-id hang to avoid | fail safe, no hang                |
| Nested / all-wallet categories | not modelled                        | `label` layer                     |

The web backend is the default because it needs nothing extra. Choose per
command with `--backend mobile`, or set `MONEYLOVER_BACKEND`.

The mobile backend needs `MONEYLOVER_MOBILE_CLIENT` and
`MONEYLOVER_MOBILE_SECRET`. Those aren't shipped here — they're embedded in
every copy of the Android app, so they aren't a secret of yours, but putting
them in a public repo would get them rotated and break everyone.
[docs/api.md](docs/api.md) explains what they are.

## The one thing to know before you start

**A Money Lover account allows only a handful of devices to hold a token at once
— five, currently — and every login registers another one.** Nothing gets kicked
off when you reach the limit; instead the _next_ login is refused, with "Maximum
device limit reached. Please log out to continue." So you don't lose data — you
lose the ability to sign in at all, including on a replacement phone, until you
log out from a device you still have.

So this caches your token under `~/.config/moneylover-kit/` and reuses it until
it expires. Don't work around that: a tool that logs in per process or per
container start will burn through every slot for nothing.

Set `MONEYLOVER_ACCESS_TOKEN` to supply a token directly and never log in.

## Environment

|                                                         |                                |
| ------------------------------------------------------- | ------------------------------ |
| `MONEYLOVER_EMAIL` · `MONEYLOVER_PASSWORD`              | credentials                    |
| `MONEYLOVER_ACCESS_TOKEN`                               | use this token, never log in   |
| `MONEYLOVER_BACKEND`                                    | `web` (default) or `mobile`    |
| `MONEYLOVER_MOBILE_CLIENT` · `MONEYLOVER_MOBILE_SECRET` | required by the mobile backend |
| `MONEYLOVER_CONFIG_DIR`                                 | where the token cache lives    |
| `MCP_TOKEN` · `MCP_PORT` · `MCP_HOST`                   | HTTP MCP transport             |

## Docs

- [docs/api.md](docs/api.md) — both APIs: auth, endpoints, item shapes
- [docs/traps.md](docs/traps.md) — everything that cost a day to work out
- [docs/mcp.md](docs/mcp.md) — wiring the MCP server into a client
- [spec/](spec/) — OpenAPI spec for the web API, plus observed schemas

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). `npm run verify` runs typecheck, lint,
formatting and the codebase-health gate.

## Licence

MIT. Use it against your own account.
