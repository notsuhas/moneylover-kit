import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { aTransaction, aWallet } from "../../core/__tests__/fixtures.js";
import * as render from "../render.js";

const realLog = console.log;
let lines: string[] = [];

function capture(): string[] {
  lines = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return lines;
}

afterEach(() => {
  console.log = realLog;
});

const names = new Map([
  ["w1", "Savings"],
  ["w2", "Current"],
]);

describe("output", () => {
  it("prints JSON when asked, ignoring the table", () => {
    const out = capture();
    render.output(true, { a: 1 }, () => console.log("table"));
    assert.deepEqual(out, ['{\n  "a": 1\n}']);
  });

  it("prints the table when not asked for JSON", () => {
    const out = capture();
    render.output(false, { a: 1 }, () => console.log("table"));
    assert.deepEqual(out, ["table"]);
  });

  it("falls back to JSON when there is no table renderer", () => {
    const out = capture();
    render.output(false, { a: 1 });
    assert.match(out[0] ?? "", /"a": 1/);
  });
});

describe("transactions", () => {
  it("says so plainly when nothing matched", () => {
    const out = capture();
    render.transactions([], names);
    assert.deepEqual(out, ["no matching transactions"]);
  });

  it("shows the sign, the wallet name and the id", () => {
    const out = capture();
    render.transactions(
      [aTransaction({ id: "abc123", amount: -480.5, note: "DMart", categoryName: "Groceries" })],
      names,
    );
    assert.match(out[0] ?? "", /-480\.50/);
    assert.match(out[0] ?? "", /Groceries/);
    assert.match(out[0] ?? "", /Savings/);
    assert.match(out[1] ?? "", /id abc123/);
  });

  it("marks income with a plus", () => {
    const out = capture();
    render.transactions([aTransaction({ id: "a", amount: 45000, note: "Payslip" })], names);
    assert.match(out[0] ?? "", /\+45000\.00/);
  });

  it("shows an em dash for an empty note, so columns still line up", () => {
    const out = capture();
    render.transactions([aTransaction({ id: "a", note: "" })], names);
    assert.match(out[0] ?? "", /—/);
  });

  it("tags people and the excluded flag", () => {
    const out = capture();
    render.transactions([aTransaction({ id: "a", people: ["Sam"], excludeReport: true })], names);
    assert.match(out[0] ?? "", /with:Sam/);
    assert.match(out[0] ?? "", /excluded/);
  });

  it("shows a question mark for a wallet it cannot name, rather than an id", () => {
    const out = capture();
    render.transactions([aTransaction({ id: "a", walletId: "unknown" })], names);
    assert.match(out[0] ?? "", /\?/);
  });

  it("reports the count", () => {
    const out = capture();
    render.transactions([aTransaction({ id: "a" }), aTransaction({ id: "b" })], names);
    assert.match(out.at(-1) ?? "", /2 transaction\(s\)/);
  });
});

describe("wallets", () => {
  it("shows the balance when there is one", () => {
    const out = capture();
    render.wallets([aWallet({ id: "w1", name: "Savings", balance: { INR: "1200.00" } })]);
    assert.match(out[0] ?? "", /Savings/);
    assert.match(out[0] ?? "", /1200\.00 INR/);
  });

  it("marks an archived wallet", () => {
    const out = capture();
    render.wallets([aWallet({ id: "w1", name: "Old", archived: true })]);
    assert.match(out[0] ?? "", /\(archived\)/);
  });

  it("prints a wallet with no balance without crashing", () => {
    const out = capture();
    render.wallets([aWallet({ id: "w1", name: "Cash" })]);
    assert.match(out[0] ?? "", /Cash/);
  });
});

describe("categories", () => {
  it("shows the name and direction", () => {
    const out = capture();
    render.categories([
      { id: "c1", name: "Groceries", icon: "i", type: "expense" },
      { id: "c2", name: "Salary", icon: "i", type: "income" },
    ]);
    assert.match(out[0] ?? "", /Groceries\s+expense/);
    assert.match(out[1] ?? "", /Salary\s+income/);
  });
});

describe("events", () => {
  it("lists names only", () => {
    const out = capture();
    render.events([{ id: "e1", name: "Goa" }]);
    assert.deepEqual(out, ["Goa"]);
  });
});

describe("labels", () => {
  it("says when a label spans every wallet", () => {
    const out = capture();
    render.labels([
      {
        id: "l1",
        name: "Groceries",
        icon: "i",
        type: "expense",
        categoryIds: [],
        excludedWalletIds: [],
      },
    ]);
    assert.match(out[0] ?? "", /all wallets/);
  });

  it("names the parent when nested", () => {
    const out = capture();
    render.labels([
      { id: "p", name: "Food", icon: "i", type: "expense", categoryIds: [], excludedWalletIds: [] },
      {
        id: "c",
        name: "Groceries",
        icon: "i",
        type: "expense",
        categoryIds: [],
        excludedWalletIds: ["w9"],
        parentId: "p",
      },
    ]);
    assert.match(out[1] ?? "", /some wallets under Food/);
  });
});

describe("lending", () => {
  it("says so plainly when there is nothing", () => {
    const out = capture();
    render.lending([]);
    assert.deepEqual(out, ["no lending activity found"]);
  });

  it("prints a header, the rows, and both totals", () => {
    const out = capture();
    render.lending([
      {
        person: "Sam",
        currencyId: 11,
        lent: 5000,
        collected: 3000,
        outstanding: 2000,
        borrowed: 0,
        repaid: 0,
        owing: 0,
        transactionCount: 2,
      },
      {
        person: "Jordan",
        currencyId: 11,
        lent: 0,
        collected: 0,
        outstanding: 0,
        borrowed: 800,
        repaid: 350,
        owing: 450,
        transactionCount: 2,
      },
    ]);
    assert.match(out[0] ?? "", /person\s+lent\s+collected\s+outstanding\s+you owe/);
    assert.match(out[1] ?? "", /Sam/);
    assert.match(out.at(-1) ?? "", /owed to you 2000\.00\s+you owe 450\.00/);
  });
});
