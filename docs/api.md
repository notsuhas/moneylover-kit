# The APIs

Money Lover has two, and neither is documented or supported. Both are reachable
with only an email and password. Read [traps.md](traps.md) before writing
anything.

| | `web.moneylover.me/api` | `revoapi.moneylover.me` |
|---|---|---|
| Used by | the web app | the Android and iOS apps |
| Style | RPC-ish: one POST per operation | a sync protocol: pull and push |
| Auth header | `Authorization: AuthJWT <token>` | `Authorization: Bearer <token>` |
| Wallet balances | **yes** | no |
| `createdAt` | yes | no |
| Nested / all-wallet categories | not modelled | the `label` layer |
| Write safety | a wrong id hangs for ~120s | rejected items come back in `failedItems` |
| Setup | email + password | also the app's OAuth client |
| Events / trips | no route (all 404) | yes |
| Batched writes | one per request | up to 50 per request |

The client composes both and routes per operation, so you normally do not pick
one — see the routing table in the README. What follows is what each API can
actually do.

`spec/web-openapi.yaml` is an OpenAPI 3.1 description of the web API, inferred
from real responses, plus `spec/web-observed-schemas.json` with per-field
frequencies.

## Authenticating

### Web

```
POST https://web.moneylover.me/api/user/login-url
  (no headers)
  -> {"data": {"request_token": "…", "login_url": "https://oauth.moneylover.me/auth?client=…"}}

POST https://oauth.moneylover.me/token
  Authorization: Bearer <request_token>
  Client: <the ?client= value from login_url>
  Content-Type: application/x-www-form-urlencoded

  email=you%40example.com&password=…
  -> {"access_token": "…", …}
```

Then send `Authorization: AuthJWT <access_token>` on every call. Note the
scheme: sent as `Bearer`, this API returns `error: 0` with empty `data` —
accepted, but no rows.

### Mobile

```
POST https://oauth.moneylover.me/request-token
  Authorization: Basic base64(<client>:<secret>)
  -> {"request_token": "…"}

POST https://oauth.moneylover.me/token
  Authorization: Bearer <request_token>
  {"email": "…", "password": "…", "grant_type": "password", …}
  -> {"status": true, "access_token": "…", "refresh_token": "…"}
```

Then `Authorization: Bearer <access_token>`, plus `client`, `apiversion: 4`,
`platform` and `appversion` headers.

The `refresh_token` has a very long expiry but is not usable: the oauth refresh
grant errors, and `revoapi` has no refresh route. Treat the 7-day access token
as the real lifetime.

#### The mobile OAuth client

`<client>` and `<secret>` are the Android app's own credentials, hardcoded in
every copy of the app. They are not a secret of *yours* — anyone can read them
out of the APK — but they are not published here, because a searchable public
copy is what gets them rotated, and rotating them breaks every user of every
unofficial client at once.

To get them: pull the APK, decompile it, and find the pair passed as HTTP Basic
to `oauth.moneylover.me/request-token`. Then:

```bash
export MONEYLOVER_MOBILE_CLIENT="…"
export MONEYLOVER_MOBILE_SECRET="…"
export MONEYLOVER_BACKEND=mobile
```

If you don't need balances and don't need nested categories, the web backend is
the better default and needs none of this.

## Web endpoints

Every one is a `POST`. `error: 0` means success.

| Path | Body | Returns |
|---|---|---|
| `/user/info` | `{}` | account, `limitDevice`, client settings |
| `/wallet/list` | `{}` | wallets **with balances** |
| `/category/list-all` | `{}` | one id per category name — the id writes accept |
| `/category/list` | `{walletId}` | per-wallet ids — **writes hang on these** |
| `/transaction/list-all` | `{}` | every transaction, all fields |
| `/event/list` | `{}` | events / trips |
| `/transaction/add` | see below | `{_id}` |
| `/transaction/edit` | the same plus `_id` | a full replace |
| `/transaction/delete` | `{_id, delRelated}` | |

```jsonc
// transaction/add — note `account` and `category`, not walletId/categoryId
{
  "account": "<wallet _id>",
  "category": "<category _id from category/list-all>",
  "amount": 1,                   // always positive
  "note": "",
  "displayDate": "2026-09-10",
  "event": "",
  "exclude_report": false,
  "with": [],
  "latitude": 0,
  "longtitude": 0,               // sic — the API misspells it
  "addressName": "", "addressDetails": "", "addressIcon": "", "image": ""
}
```

Created ids are prefixed `web`. The server may return a **different**
`category` id than you sent, resolving it to the equivalent category in the
target wallet.

## Mobile endpoints

```
POST /api/user/info

POST /api/sync/pull/{account,category/v2,transaction/v2,label,campaign/v2,budget/v2}
     {last_update: 0, skip, limit, av, pl}

POST /api/sync/push/{transaction/v2,category/v2,label}
     {data: "{\"d\":[<items>]}", av, pl}
```

Pulls are paginated — drain until a page comes back short. Pushes carry `f`:
**1 create, 2 update, 3 delete** (delete also needs `isDelete: true`), and
answer `{status, data: [{gid, syncFlag}], failedItems}`.

### Item shapes

Short keys. Recovered by intercepting the Android app's traffic; it pins no
certificates, so a system CA is enough.

```
transaction  {a: amount, ac: wallet, c: category (per-wallet id!), cp: [event ids],
              dd: "YYYY-MM-DD", er: exclude_report, im: images, la/lo: lat/long,
              md: metadata, mr: mark_report, n: note, p: [people], rd: remind,
              gid, f, version}

category     {ac: wallet, gid, n: name, ic: icon, t: 1 income|2 expense,
              md: metadata, gr: group, id: local int, pi: parent's per-wallet gid,
              f, version}

label        {gid, n, ic, t, md, pi: parent label gid, c: [per-wallet gids],
              eac: [excluded wallets — empty means all], f, v}
```

Reads come back **decoded**, with long field names: a label reads as
`{name, icon, type, exclude_accounts, categories, parent: {_id}}` while a push
wants `{n, ic, t, eac, c, pi}`. Don't reach for `l.n` on a row you just read.

## Lending

Money Lover models money between people with four system categories, marked in
`metadata` rather than by name:

| `metadata` | Meaning | Type |
|---|---|---|
| `IS_LOAN` | you lend money out | expense |
| `IS_DEBT_COLLECTION` | it comes back | income |
| `IS_DEBT` | you borrow | income |
| `IS_REPAYMENT` | you pay it back | expense |

The person goes in `with`. Nothing links the two legs of a loan, so the
outstanding balance is derived: sum the loans, subtract the collections, group
by person. Because the person carries it, lending from one wallet and being
repaid into another reconciles by itself.

There is also a `debt` resource (`debt/list/full` exists) which the apps use for
their own loan view. Its shape is not documented here.

## Not covered

- **Recurring transactions** are a shipped feature and no endpoint for them
  could be found across roughly 1,200 probed paths.
- **Budgets** pull on mobile but nothing here writes them.
- **`report/{type}`** is one catch-all wildcard route; every date and wallet
  combination tried returned `sync_error_have_not_permission`. Possibly
  premium-gated.
- **Write payloads for wallets and budgets.** They exist and answer `error: 1`
  to an empty body, but probing them means writing to a live financial account.

Absence from this document is not evidence of absence from the API.
