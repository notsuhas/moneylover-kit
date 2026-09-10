export const USAGE = `moneylover — unofficial Money Lover CLI

  moneylover login                      mint and cache a token (registers a device)
  moneylover whoami                     account, backend, device limit
  moneylover wallets                    wallets, with balances where available
  moneylover categories                 category names valid for writing
  moneylover events                     event/trip names
  moneylover labels                     global category records (mobile backend only)

Structure
  moneylover add-wallet    --name N --currency 11 [--icon I]
  moneylover edit-wallet   --wallet W [--name N] [--icon I] [--currency C]
  moneylover rm-wallet     --wallet W             takes its transactions with it
  moneylover add-category  --name N [--type income|expense] [--icon I]
                           [--wallet W | --all-wallets] [--parent P]
  moneylover edit-category --category C [--name N] [--icon I]
  moneylover rm-category   --category C

  --all-wallets and --parent need the mobile backend: an all-wallet or nested
  category lives in the label layer, which the web API does not model.

Transactions
  moneylover list [filters]             list transactions
  moneylover add --wallet W --category C --amount N [...]
  moneylover edit <id> [fields]
  moneylover rm <id>

Lending
  moneylover lend    --person P --amount N --wallet W    money you handed over
  moneylover collect --person P --amount N --wallet W    money that came back
  moneylover borrow  --person P --amount N --wallet W    money you took
  moneylover repay   --person P --amount N --wallet W    money you paid back
  moneylover lending [--person P]                        who owes what, net

  Amounts here are always positive — the verb sets the direction. The wallet is
  per leg, so lending from one account and collecting into another is fine.

Filters for \`list\`
  --note TEXT --wallet W --category C --from YYYY-MM-DD --to YYYY-MM-DD
  --min N --max N --limit N

Fields for \`add\` and \`edit\`
  --wallet W --category C --amount N    amount is signed: -450 spent, 4500 earned
  --note TEXT --date YYYY-MM-DD
  --with "Alice,Bob"                    people; on edit this replaces the list
  --exclude-report                      keep it out of spending reports

Global
  --backend web|mobile                  default web, or MONEYLOVER_BACKEND
  --json                                machine-readable output
  --help

Credentials come from MONEYLOVER_EMAIL and MONEYLOVER_PASSWORD, or
MONEYLOVER_ACCESS_TOKEN to skip logging in. The token is cached, because every
login registers a device and an account allows only a few at once.`;
