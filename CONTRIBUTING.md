# Contributing

```bash
npm install
npm run verify        # typecheck, lint, format, tests, health
```

`npm run verify` is what CI runs. If it passes locally it passes there.

## The tooling, and who owns what

One tool per job, so nothing is checked twice or fought over:

|               | Owns                                                          |
| ------------- | ------------------------------------------------------------- |
| **Biome**     | lint and format for `.ts`, `.js`, `.json`                     |
| **Prettier**  | format for `.md`, `.yaml` — Biome does not support these yet  |
| **tsc**       | types, in strict mode with `noUncheckedIndexedAccess`         |
| **node:test** | tests, via the built-in runner — no test framework dependency |
| **Fallow**    | dead code, duplication, complexity                            |

`npm run format` fixes everything fixable.

Fallow's dead-code and duplication checks are expected to stay at zero. Its
health score is advisory and does not gate CI: a low score on a file is a prompt
to look, not a reason to block a correct fix.

## What tests to write

Only the pure logic is tested, and deliberately so — there are no mocked HTTP
fixtures, because a fixture of an undocumented API mostly tests that the fixture
still matches itself.

So: put the logic worth protecting in a pure function and test that. Sign
handling, filtering, the category id fallback and the lending arithmetic all
live in `src/query.ts`, `src/normalise.ts` and `src/lending.ts` for this reason.
Backends stay thin enough to read.

Every test in `test/pure.test.ts` corresponds to a mistake made against a real
account. If you fix a bug, add the case that would have caught it.

## Style

- Files stay under about 250 lines. That is a prompt to look for a second
  responsibility, not a hard rule — split when you can name the extracted piece
  without the word "utils".
- Comments explain **why**, in one line. If a comment needs a paragraph to
  justify the code, the code is usually the problem.
- Public API is exported from `src/index.ts` and nothing else. An export with no
  consumer is dead code, and Fallow will say so.

## Testing against a real account

There is no sandbox. Anything you run touches real money.

- Read-only commands are safe: `whoami`, `wallets`, `categories`, `list`,
  `lending`.
- For writes, add a transaction with an obvious note, verify it, then delete it.
- **Do not log in repeatedly.** Every login registers a device against a limit
  of five. Nothing is evicted when you reach it — the next login is simply
  refused until you log out somewhere, which can mean locking yourself out of
  your own account. `moneylover login` once; after that the cached token is
  reused.

## Reporting an API discovery

The most valuable contribution here is not code. If you find an endpoint, a
field, or a behaviour that isn't in [docs/api.md](docs/api.md) or
[docs/traps.md](docs/traps.md), open an issue with the request and response —
credentials removed.

Corrections especially welcome. Several things in those docs were stated
confidently and turned out to be wrong.
