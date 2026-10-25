# Alpaca Anlage KAP Calculator

JavaScript port inspired by <https://github.com/javier-ruiz-b/eToro-Anlage-KAP-calculator>, but built around Alpaca account activities and FIFO lot matching.

This tool:

- pulls historical Alpaca account activities via `@alpacahq/alpaca-trade-api`
- supports one or many Alpaca accounts in a single run
- reconstructs realized sales with FIFO per account
- converts USD amounts into EUR using Bundesbank USD/EUR reference data
- emits a German tax-style summary for `Anlage KAP`, both per account and as a combined total
- emits a separate `Anlage SO` summary for crypto disposals

## Important limits

- This is a helper, not tax advice.
- ETF vs stock classification is heuristic unless you provide overrides.
- `Anlage KAP` line 18 (`Inländische Kapitalerträge`) defaults to `0`, because Alpaca data does not provide enough German domestic classification by itself.
- Corporate actions, short sales, options exercises/assignments, and complex basis adjustments are not fully modeled yet.

## Setup

1. Use Node.js 18+.
2. Install dependencies:

```bash
npm install
```

3. Create `.env` from `.env.example` and set your Alpaca credentials:

```bash
cp .env.example .env
```

4. Run the calculator:

```bash
node src/cli.js --year 2025
```

## Multiple accounts

There are two ways to configure multiple accounts.

### Option 1: Environment variables

List the account names in `ALPACA_ACCOUNTS`, then provide credentials per account:

```bash
ALPACA_ACCOUNTS=account1,account2
ALPACA_ACCOUNT1_KEY_ID=...
ALPACA_ACCOUNT1_SECRET_KEY=...
ALPACA_ACCOUNT1_PAPER=false
ALPACA_ACCOUNT2_KEY_ID=...
ALPACA_ACCOUNT2_SECRET_KEY=...
ALPACA_ACCOUNT2_PAPER=false
```

Account names are normalized for environment variable lookup, so `account-1` maps to `ALPACA_ACCOUNT_1_KEY_ID` and `ALPACA_ACCOUNT_1_SECRET_KEY`.

### Option 2: Accounts file

Create `accounts.json`:

```json
{
  "accounts": [
    { "name": "Account1" },
    { "name": "Account2" }
  ]
}
```

Each entry then reads credentials from `ALPACA_<NAME>_KEY_ID` and `ALPACA_<NAME>_SECRET_KEY`.

You can also reference explicit environment variables or pass credentials directly:

```json
{
  "accounts": [
    {
      "name": "Account1",
      "keyIdEnv": "ALPACA_ACCOUNT1_KEY_ID",
      "secretKeyEnv": "ALPACA_ACCOUNT1_SECRET_KEY",
      "paper": false
    },
    {
      "name": "Account2",
      "keyIdEnv": "ALPACA_ACCOUNT2_KEY_ID",
      "secretKeyEnv": "ALPACA_ACCOUNT2_SECRET_KEY",
      "paper": false
    }
  ]
}
```

Run with:

```bash
node src/cli.js --year 2025 --accounts ./accounts.json
```

If you only configure `ALPACA_KEY_ID` and `ALPACA_SECRET_KEY`, the tool treats it as a single account named `Default`. Set `ALPACA_ACCOUNT_NAME` to change that name.

## Output

The script writes:

- `output/<year>-summary.json` with per-account summaries under `accounts`, the combined figures under `total`, and backward-compatible top-level totals
- `output/<year>-realized-sales.json` with an `account` field on every sale
- `output/<year>-dividends-fees-adjustments.json` with an `account` field on every cash activity
- `output/<year>_FIFO_Berechnung.xlsx` with:
  - `Gesamt`: total `Anlage KAP` and `Anlage SO` figures for all accounts
  - `Konten`: one row per account plus a `Gesamt` row with the key tax figures
  - one summary sheet per account
  - combined `Verkaeufe`, `Lots`, and `Zahlungen` sheets with a `konto` column

## Optional symbol overrides

You can provide `symbol-overrides.json` in the project root to force classification:

```json
{
  "SPY": { "type": "etf", "domestic": false },
  "AAPL": { "type": "stock", "domestic": false },
  "BTCUSD": { "type": "crypto", "domestic": false }
}
```

Run with:

```bash
node src/cli.js --year 2025 --symbol-overrides ./symbol-overrides.json
```
