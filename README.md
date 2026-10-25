# Alpaca Anlage KAP Calculator

JavaScript port inspired by <https://github.com/javier-ruiz-b/eToro-Anlage-KAP-calculator>, but built around Alpaca account activities and FIFO lot matching.

This tool:

- pulls historical Alpaca account activities via `@alpacahq/alpaca-trade-api`
- reconstructs realized sales with FIFO
- converts USD amounts into EUR using Bundesbank USD/EUR reference data
- emits a German tax-style summary for `Anlage KAP`
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

## Output

The script writes:

- `output/<year>-summary.json`
- `output/<year>-realized-sales.json`
- `output/<year>-dividends-fees-adjustments.json`

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
