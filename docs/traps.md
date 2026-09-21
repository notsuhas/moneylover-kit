# Traps

Everything here cost real time to work out. If you are writing your own client,
this is the part worth reading.

## Auth

### Logging in costs you a device slot

An account allows a fixed number of devices to hold a token at once — five,
currently, reported as `limitDevice` on `user/info`. **Every login registers
another one.**

Nothing is evicted when you reach the limit. Money Lover refuses the *new* login
instead: "Maximum device limit reached. Please log out to continue." So the
failure is not silent data loss — it is being unable to sign in, including on a
replacement phone, until you log out from a device you still have.

Either way, cache the token and reuse it until it expires. A tool that logs in
per process, per container start or per request will exhaust every slot from one
machine and leave the owner unable to log in anywhere else.

### A token that mints fine can still be dead

The access token carries a `tokenDevice` that must be registered on the account.
Remove that device — from the app, or from the account's device list — and the
same credentials keep minting perfectly valid-looking tokens while every call
returns `e:717` — **reads included**. Nothing about the token looks wrong. If
everything suddenly 717s, this device is no longer on the account; log in again
to register a new one.

### Both tokens renew, but through different protocols

The web API renews an access token from its refresh token:

```
POST web.moneylover.me/api/user/refresh-token   {refreshToken}
  -> {access_token, refresh_token}    no Authorization header, no client secret
```

Verified against a live account, the renewed token carries the **same**
`tokenDevice` — so no device slot is consumed — and the refresh token rotates,
so the chain continues indefinitely. That makes a web-backed service
self-maintaining.

The Android app uses a different, non-standard route:

```
POST oauth.moneylover.me/refresh-token   Authorization: Bearer <refreshToken>
{}                                      -> {access_token, refresh_token}
```

The empty JSON body matters. Standard `grant_type=refresh_token` requests fail,
and the web refresh endpoint rejects a mobile-issued token. This exact request
was recovered from Android 8.78.0.171 and verified against a live account: it
rotates both tokens without registering another device.

### A fixed `did` does not pin a device

Worth stating because it looks like it should. The mobile login accepts a `did`
and `na`, but the server issues its own `tokenDevice` UUID regardless: two
logins one minute apart with an identical `did` produced
`650bb6fe…` and `a53c0f9b…`. Every login is a new device, so a service that
logs in repeatedly still exhausts the account. Refresh instead.

Logins are also rate-limited — a second one seconds later answered
`TooManyRequests` — so retrying on failure makes things worse, not better.

### Password login is scriptable, on both APIs

Widely believed otherwise, including by an earlier version of this document.

The **web browser** flow posts to `oauth.moneylover.me/web/token` with an
invisible `g-recaptcha-response`, which you cannot replay. But there is a
*different* endpoint that has no captcha at all:

```
POST web.moneylover.me/api/user/login-url     (no auth)  -> {request_token, login_url}
POST oauth.moneylover.me/token
     Authorization: Bearer <request_token>
     Client: <the ?client= from login_url>
     Content-Type: application/x-www-form-urlencoded
     email=…&password=…                                  -> access_token
```

The **mobile** flow is the same shape with the Android app's own client
credentials over HTTP Basic, then a password grant. Neither needs a browser.

### Signing out revokes nothing

A token captured before a logout still authenticates afterwards. These live
until their `exp` regardless. Treat them as bearer secrets.

## Requests

### HTTP is always 200 — read the body

The status line tells you nothing. The real result is the `error` field, where
`0` is success and `1` means the route exists but rejected your payload.

### There are four response shapes, and a naive client handles one

- normal — `{error, msg, action, data}`
- rejected token — `{s: false, e: 706, msg, router}`, with **abbreviated keys**,
  so code checking only `error` sails straight past it
- **missing** `Authorization` header — a normal envelope, `error: 0`, empty
  `data`. Completely silent. **An empty result is not proof of an empty
  account.**
- malformed JSON body — a raw Express `body-parser` stack trace

### Cloudflare blocks non-browser User-Agents

Before the request reaches Money Lover, and it fails in a way that reads as an
auth problem. Send a browser UA.

### The connection resets under concurrency

`fetch` *throws* rather than returning a response, so a retry that only inspects
`res.status` misses it entirely. Keep calls sequential and retry thrown network
errors as well as 429/5xx.

## Categories

### A category id is per-wallet, and the two lists disagree

This is the expensive one.

`category/list-all` returns one id per category name. `category/list?walletId=…`
returns a *different* id for the same category, scoped to that wallet. On the
web API, writes accept only the former:

```
category/list-all              -> 5AA93F5F…   writes ACCEPT this
category/list?walletId=<id>    -> BEF46AF6…   writes HANG on this
```

Send the wrong one and `transaction/add|edit` **holds the connection until
Cloudflare returns 524 at about 120 seconds**. It never answers with an error.
And a successful response echoes the wallet-scoped id back, so the value that
fails is the one you see in your own results.

Generalise it: **on this API a rejected id can hang instead of erroring.** If a
write times out, suspect an id before an outage. A hung write never commits
(verified across a dozen attempts), so a timeout does not create duplicates.

### A transaction's category id matches neither list

Following directly from the above: on the web API, `transaction/list-all`
returns the wallet-scoped category id, so comparing it against
`category/list-all` matches **nothing at all**. Zero of 11,194 rows, on a real
account.

The transaction does carry `category.name`, so index categories by id *and*
lowercased name and look up by either. The mobile API is the mirror image — ids
match, names are absent — so an index over both covers either backend. That's
what `categoryIndex()` is for.

### An edit needs every field, even the ones you aren't changing

`wallet/edit` rejects `{_id, name}` with `sync_error_data_invalid`. It wants
`{_id, name, icon, currency_id}` — all four. `category/edit` is the same with
`{_id, name, icon}`. So an edit has to read the live row and resend all of it,
which is what this client does.

### A new category is invisible for a few seconds

`category/add` returns a provisional `web…` id that `category/list-all` does
not show yet, and cannot be assigned to a transaction until it does. So a
create followed immediately by a read-back will fail on a write that actually
succeeded. Trust the returned id, don't re-read to confirm.

### The field name for a wallet changes per endpoint

| Endpoint | Wallet field |
|---|---|
| every read | `walletId` |
| `transaction/add` · `transaction/edit` | **`account`** |
| `category/add` | **`walletId`** |

Three conventions in one API. This is why guessing a write payload from a read
endpoint cannot work.

### `metadata: IS_*` marks a system category

`IS_LOAN`, `IS_DEBT`, `IS_DEBT_COLLECTION`, `IS_REPAYMENT`,
`IS_OUTGOING_TRANSFER`, `IS_UNCATEGORIZED_EXPENSE` and friends. The app
special-cases these. Never rename or delete one.

They are also the *right* way to find lending categories: the metadata is
stable, the display name is localised. Keying on `"Loan"` breaks on a
non-English account.

### Categories have two layers, and only one of them nests

On the mobile API:

- **`category`** is the per-wallet row. A transaction points at one of these,
  which is why the same category has a different id in every wallet.
- **`label`** is the global record grouping them: `categories` lists the
  per-wallet ids, `exclude_accounts` empty means every wallet, and `parent` is
  the nesting link.

Write only the `category` rows and you get N unrelated wallet-local categories.
The label layer is the only thing that can express "one category, in all
wallets, nested under a parent". The web API models none of this.

## Writes

### A transaction write is a full replace, not a patch

Omit a field and it is **cleared**. The list of things this quietly destroys is
longer than it first appears: people (`with`), the event, `exclude_report`, the
reminder, the receipt image, the location, the address, and the `metadata` the
official client keeps its own state in. Always re-read the row and rebuild the
whole object from it.

Two asymmetries make it worse. The read field is `images` (a list) while the
write field is `image` (one string). And a category push is a full replace too,
so an edit that rebuilds a row from its name and icon alone silently unnests it
by dropping `pi`.

This is the reason no other client offers an update: it looks like it works.

### Mobile writes are a sync protocol and fail safe

```
POST /api/sync/push/{transaction,category}/v2   {data: '{"d":[items]}', av, pl}
```

`f` is the sync flag — 1 create, 2 update, 3 delete (delete also needs
`isDelete: true`). The response is `{status, data:[{gid, syncFlag}],
failedItems}`, and a malformed item comes back in `failedItems` **instead of
being applied**. Much safer than the web equivalent.

### Only `apiversion: 4` is accepted

On the mobile API. 2, 3, 5 and 6 all answer `706`. `av` and `platform` change
nothing.

### Write payloads can't be brute-forced

`transaction/add` answers `sync_error_data_invalid_format` for an empty body
*and* for every partial payload, so there is no error signal to hill-climb on.
The shapes in [api.md](api.md) were recovered by watching the real clients.

## Data model

### The amount is unsigned; the direction is in the category

Every wire amount is positive. Whether it is income or expense comes from the
category's `type` — 1 income, 2 expense. So an amount alone is meaningless, and
a client that lets you pass `+500` against an expense category should reject it
rather than guess.

### `transaction/config-search` is a trap

It is what the web app itself calls, but it returns a reduced projection with no
`note`, no `displayDate` and no `account`. Use `transaction/list-all`.

### Mobile has no balance field

The mobile wallet pull returns no balance field. The client derives the exact
balance from its persistent transaction sync, excluding future-dated rows just
like the app.

Balances exclude **future-dated** transactions, while a transaction list
includes them, so the two reconcile only after you subtract future rows. If your
own totals disagree by a suspiciously round amount, look for scheduled
transactions dated ahead of today before assuming anything is broken.

### A category is stored once per wallet, so an edit is N writes

Renaming a category on the mobile API means pushing one item per wallet plus
the label. Miss the label and the app still shows the old name; miss a wallet
and that wallet disagrees with the rest.

Related: a label with an empty `exclude_accounts` means "active in every
wallet". So a category created in **one** wallet needs every *other* wallet
listed as excluded, or the label claims a scope its rows do not have.

### The two APIs do not agree on ids, except where they do

Measured on a live account:

| | Shared across both APIs? |
|---|---|
| wallet ids | yes — 13 of 13 |
| transaction ids | yes — 11,194 of 11,194 |
| category ids | **no — 0 shared** |
| category *names* | yes — 60 of 60 |

So you can read a transaction from one API and write it through the other. You
cannot do that with a category id. Worse, a transaction's `category` id is the
**per-wallet** one on *both* APIs, while web's `category/list-all` returns a
global set that matches no transaction at all — which is why the only reliable
cross-API handle for a category is its name.

### Events are mobile-only

`/event/list`, `/campaign/list`, `/event/list-all` and `/campaign/list-all` all
404 on the web API. `/event/list/full` exists but answers
`sync_error_have_not_permission`. Events come from
`sync/pull/campaign/v2` on mobile or not at all.

### You cannot read one transaction

There is no get-by-id on either API. The only read is the whole account:
`transaction/list-all` on web (one request) or `sync/pull/transaction/v2` on
mobile (38 pages of 300 for ~11k rows). Combined with the full-replace write
format — which means an edit *must* start from the live row — a single-row edit
costs a whole-account read.

So: persist the mobile sync checkpoint and rows. After the first full pull,
balance calculation, search and full-replace edits apply only incremental
changes to that local mirror.

### Balances in different currencies are not comparable

A wallet carries a numeric `currency_id` and nothing converts between them.
Any total across wallets — a person's lending balance, for instance — has to be
grouped per currency, because adding INR 5,000 to USD 100 to get 5,100 is worse
than returning nothing.

### People are free text

`with` is an array of plain strings, so one human is often several tags —
`"Sam"` and `"Sam Fielding"`. Nothing canonicalises them. Match on substrings
and keep each tag as its own row rather than silently merging.

## A closing note on method

Three claims that were made confidently and turned out to be wrong: that the web
API could not be authenticated without a browser, that `parent` was read-only so
categories were necessarily flat, and that a category could not be made global.
All three came from testing one API and generalising.

The apps are the reference implementation. When something looks impossible,
watch what the real client does before concluding it can't be done.
