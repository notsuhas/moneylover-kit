# moneylover-kit

[![npm](https://img.shields.io/npm/v/@notsuhas/moneylover-kit)](https://www.npmjs.com/package/@notsuhas/moneylover-kit)

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
npm install -g @notsuhas/moneylover-kit    # or npx @notsuhas/moneylover-kit
```

To run it from source instead, clone and build —
`npm install -g github:notsuhas/moneylover-kit` does _not_ work, because npm
skips devDependencies when preparing a git dependency and leaves no compiler to
build with:

```bash
git clone https://github.com/notsuhas/moneylover-kit && cd moneylover-kit
npm ci && npm run build && npm install -g .
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

Managing wallets, categories and events is opt-in, behind two flags:
`MONEYLOVER_MCP_ALLOW_STRUCTURE=1` for creating and editing them, and
`MONEYLOVER_MCP_ALLOW_DELETE=1` for `delete_wallet` and `delete_category`. A
rename can be typed back; deleting a wallet takes every transaction in it and
neither API has an undo, which is why it is its own switch.

**Local, for Claude Desktop / Cursor** — add to your MCP config:

```json
{
  "mcpServers": {
    "moneylover": {
      "command": "npx",
      "args": ["-y", "-p", "@notsuhas/moneylover-kit", "moneylover-mcp"],
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

**In Docker** — a `Dockerfile` and `compose.yaml` are in the repo:

```bash
cp .env.example .env      # email, password, and an MCP_TOKEN
docker compose up -d      # POST localhost:8790/mcp
```

Mount something persistent at `/config`, as the compose file does. That is where
the token cache lives, and without it every restart spends one of the account's
device slots.

Full setup notes, including how to keep an agent from doing something
irreversible: [docs/mcp.md](docs/mcp.md).

## Library

```ts
import { createClient } from "@notsuhas/moneylover-kit";

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

## Two APIs, one client

Money Lover's web and mobile clients grew separately and **neither is a
superset**. Rather than make you pick, this composes both and routes each
operation to whichever can actually do it:

|                    | Served by | Because                                             |
| ------------------ | --------- | --------------------------------------------------- |
| wallets, balances  | web       | the only one that reports balances                  |
| transactions       | web       | one request, not 45 paginated pulls                 |
| categories         | mobile    | its ids are the ones transaction rows reference     |
| events, labels     | mobile    | every web route for these 404s                      |
| transaction writes | mobile    | rejected items fail safe; batches; no wrong-id hang |
| category writes    | mobile    | writes both layers, so nesting and all-wallet work  |
| wallet writes      | web       | the only one whose payloads are known               |

Those last two are worth explaining: **neither API can read a single
transaction.** The only read is "every transaction" — one request on web, 45
paginated pulls on mobile — and a full-replace write has to start from the live
row. So a single edit costs a whole-account read, and it matters which API pays
for it: routing edits to mobile measured 30s+, past a typical gateway timeout,
while web reuses the list the search already fetched and comes in around 10s.

That routing is measured, not assumed: wallet and transaction ids are identical
across both APIs (13/13 and 11,194/11,194 on a real account), which is what
makes it safe to read from one and write to the other. Category ids are _not_
shared — but every helper takes names, so it never comes up.

`moneylover whoami` prints the live routing table.

With only web credentials you get everything except events, labels, nested and
all-wallet categories, and batched writes — and asking for one of those names
the API you're missing instead of failing vaguely. To add mobile:

```bash
export MONEYLOVER_MOBILE_CLIENT="…"
export MONEYLOVER_MOBILE_SECRET="…"
```

Those are the Android app's own credentials, hardcoded in every copy of it. They
aren't a secret of yours, but they're not published here — a searchable public
copy is what gets them rotated, which would break every unofficial client at
once. [docs/api.md](docs/api.md) explains how to get them.

`--backend web|mobile` forces one API. It's an escape hatch for reproducing a
backend-specific behaviour, not something you should need.

Each API issues its own token and rejects the other's, so use
`MONEYLOVER_WEB_TOKEN` and `MONEYLOVER_MOBILE_TOKEN` if you supply tokens
directly. A bare `MONEYLOVER_ACCESS_TOKEN` only makes sense with `--backend`.

## The one thing to know before you start

**A Money Lover account allows only a handful of devices to hold a token at once
— five, currently — and every login registers another one.** Nothing gets kicked
off when you reach the limit; instead the _next_ login is refused, with "Maximum
device limit reached. Please log out to continue." So you don't lose data — you
lose the ability to sign in at all, including on a replacement phone, until you
log out from a device you still have.

So this caches your token under `~/.config/moneylover-kit/` and renews it the
cheap way. Both APIs rotate their refresh token while keeping the same
registered device, so a service maintains itself with no further logins. The
mobile route is non-standard: the Android app sends an empty body to
`oauth.moneylover.me/refresh-token` with the refresh token as Bearer auth.

Set `MONEYLOVER_ACCESS_TOKEN` to supply a token directly and never log in.

## Environment

|                                                         |                                   |
| ------------------------------------------------------- | --------------------------------- |
| `MONEYLOVER_EMAIL` · `MONEYLOVER_PASSWORD`              | credentials                       |
| `MONEYLOVER_ACCESS_TOKEN`                               | use this token, never log in      |
| `MONEYLOVER_BACKEND`                                    | `web` (default) or `mobile`       |
| `MONEYLOVER_MOBILE_CLIENT` · `MONEYLOVER_MOBILE_SECRET` | required by the mobile backend    |
| `MONEYLOVER_CONFIG_DIR`                                 | where the token cache lives       |
| `MCP_TOKEN` · `MCP_PORT` · `MCP_HOST`                   | HTTP MCP transport                |
| `MONEYLOVER_MCP_ALLOW_STRUCTURE`                        | MCP: wallet/category/event writes |
| `MONEYLOVER_MCP_ALLOW_DELETE`                           | MCP: wallet/category deletes      |

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
