#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");
const { createAlpacaClient, getAllActivities, getAssetMetadata, getAlpacaEnvironment } = require("./alpaca");
const { loadAccounts } = require("./accounts");
const { buildRealizedSales } = require("./fifo");
const { loadFxConverter } = require("./fx");
const { buildAdjustedCashActivities, buildClassifier, enrichRealizedSales, summarize } = require("./kap");
const { writeWorkbook } = require("./excel");

function isCryptoSymbol(symbol) {
  return typeof symbol === "string" && symbol.includes("/");
}

async function main() {
  loadDotEnv();

  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.year) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const year = Number(args.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new Error(`Invalid year: ${args.year}`);
  }

  const symbolOverrides = await loadJsonFile(args.symbolOverrides);
  const outputDir = path.resolve(args.outputDir || "output");
  await fs.mkdir(outputDir, { recursive: true });

  const accounts = await loadAccounts({ accountsPath: args.accounts });

  if (args.diagnoseAuth) {
    await runAuthDiagnostic(accounts);
    return;
  }

  const fx = await loadFxConverter(args.fxCachePath);

  const fetchAfter = args.historyStart || "2000-01-01";
  const fetchUntil = `${year + 1}-01-15`;

  const accountResults = [];
  for (const account of accounts) {
    const result = await collectAccount({
      account,
      year,
      fx,
      symbolOverrides,
      fetchAfter,
      fetchUntil,
    });
    accountResults.push(result);
  }

  const realizedSales = accountResults.flatMap((result) => result.realizedSales);
  const dividends = accountResults.flatMap((result) => result.dividends);
  const fees = accountResults.flatMap((result) => result.fees);
  const adjustments = accountResults.flatMap((result) => result.adjustments);

  const totalSummary = summarize({ sales: realizedSales, dividends, fees, adjustments });
  const totalUsdTotals = summarizeUsdTotals(realizedSales);
  const totalCounts = sumCounts(accountResults);
  const totalWarnings = accountResults.flatMap((result) =>
    result.warnings.map((warning) => `[${result.name}] ${warning}`)
  );

  const summaryPayload = {
    year,
    generatedAt: new Date().toISOString(),
    accounts: accountResults.map((result) => ({
      name: result.name,
      environment: result.environment,
      counts: result.counts,
      warnings: result.warnings,
      summary: result.summary,
      usdTotals: result.usdTotals,
    })),
    total: {
      counts: totalCounts,
      warnings: totalWarnings,
      summary: totalSummary,
      usdTotals: totalUsdTotals,
    },
    counts: totalCounts,
    assumptions: [
      "FIFO is reconstructed per account from Alpaca FILL activities within the fetched history window.",
      "USD amounts are converted to EUR with Bundesbank USD/EUR reference data.",
      "ETF detection is heuristic unless symbol-overrides.json is provided.",
      "Line 18 domestic capital income defaults to 0 unless overridden per symbol.",
      "Corporate actions and basis-changing events are not fully reconciled.",
      "Historical sell underflows before the report year are bridged with synthetic carry-in basis so they do not abort the current-year report.",
      "Totals are the sum of all configured accounts. Each account is also reported separately.",
    ],
    warnings: totalWarnings,
    summary: totalSummary,
    usdTotals: totalUsdTotals,
  };

  await fs.writeFile(
    path.join(outputDir, `${year}-summary.json`),
    JSON.stringify(summaryPayload, null, 2),
    "utf8"
  );
  await fs.writeFile(
    path.join(outputDir, `${year}-realized-sales.json`),
    JSON.stringify(realizedSales, null, 2),
    "utf8"
  );
  await fs.writeFile(
    path.join(outputDir, `${year}-dividends-fees-adjustments.json`),
    JSON.stringify({ dividends, fees, adjustments }, null, 2),
    "utf8"
  );
  const workbookPath = writeWorkbook({
    year,
    outputDir,
    summaryPayload,
    accounts: accountResults,
  });
  summaryPayload.outputFiles = {
    summaryJson: path.join(outputDir, `${year}-summary.json`),
    realizedSalesJson: path.join(outputDir, `${year}-realized-sales.json`),
    cashActivitiesJson: path.join(outputDir, `${year}-dividends-fees-adjustments.json`),
    reportXlsx: workbookPath,
  };
  await fs.writeFile(
    path.join(outputDir, `${year}-summary.json`),
    JSON.stringify(summaryPayload, null, 2),
    "utf8"
  );

  process.stdout.write(`${JSON.stringify(summaryPayload, null, 2)}\n`);
}

async function collectAccount({ account, year, fx, symbolOverrides, fetchAfter, fetchUntil }) {
  try {
    const alpaca = createAlpacaClient(account);
    const environment = getAlpacaEnvironment(account);

    const activities = await getAllActivities(alpaca, { after: fetchAfter, until: fetchUntil });
    const yearActivities = activities.filter((activity) => activityYear(activity) === year);

    const allTradeActivities = activities.filter(
      (activity) => activity.activity_type === "FILL" && !isCryptoSymbol(activity.symbol)
    );
    const dividendLikeActivities = yearActivities
      .filter((activity) =>
        ["DIV", "DIVCGL", "DIVCGS", "DIVROC", "DIVTXEX", "DIVFT", "DIVNRA", "DIVTW"].includes(
          activity.activity_type
        )
      )
      .filter((activity) => !isCryptoSymbol(activity.symbol));
    const feeActivities = yearActivities
      .filter((activity) => ["FEE", "CFEE", "PTC", "DIVFEE"].includes(activity.activity_type))
      .filter((activity) => !isCryptoSymbol(activity.symbol));
    const adjustmentActivities = yearActivities.filter((activity) =>
      ["JNLC", "JNL", "INT", "INTNRA", "INTTW", "MISC"].includes(activity.activity_type)
    );

    const fifoResult = buildRealizedSales(allTradeActivities, { reportYear: year });
    const realizedSales = fifoResult.realizedSales
      .filter((sale) => activityYear({ transaction_time: sale.soldAt }) === year)
      .map((sale) => ({ ...sale, account: account.name }));

    const symbolSet = new Set([
      ...realizedSales.map((sale) => sale.symbol),
      ...dividendLikeActivities.map((activity) => activity.symbol).filter(Boolean),
      ...feeActivities.map((activity) => activity.symbol).filter(Boolean),
    ]);

    const assetsBySymbol = new Map();
    for (const symbol of symbolSet) {
      const asset = await getAssetMetadata(alpaca, assetsBySymbol, symbol);
      assetsBySymbol.set(symbol, asset);
    }

    const classifySymbol = buildClassifier(symbolOverrides, assetsBySymbol);

    const enrichedSales = enrichRealizedSales(realizedSales, fx, classifySymbol);
    const dividends = buildAdjustedCashActivities(dividendLikeActivities, fx).map((item) => ({
      ...item,
      account: account.name,
      assetType: classifySymbol(item.symbol || "").type,
      domestic: Boolean(classifySymbol(item.symbol || "").domestic),
    }));
    const fees = buildAdjustedCashActivities(feeActivities, fx).map((item) => ({
      ...item,
      account: account.name,
      assetType: classifySymbol(item.symbol || "").type,
      domestic: Boolean(classifySymbol(item.symbol || "").domestic),
    }));
    const adjustments = buildAdjustedCashActivities(adjustmentActivities, fx).map((item) => ({
      ...item,
      account: account.name,
      assetType: classifySymbol(item.symbol || "").type,
      domestic: Boolean(classifySymbol(item.symbol || "").domestic),
    }));

    const summary = summarize({
      sales: enrichedSales,
      dividends,
      fees,
      adjustments,
    });

    return {
      name: account.name,
      environment,
      counts: {
        activitiesFetched: activities.length,
        activitiesInTaxYear: yearActivities.length,
        realizedSales: enrichedSales.length,
        dividends: dividends.length,
        fees: fees.length,
        adjustments: adjustments.length,
        fifoWarnings: fifoResult.warnings.length,
      },
      warnings: fifoResult.warnings,
      summary,
      usdTotals: summarizeUsdTotals(enrichedSales),
      realizedSales: enrichedSales,
      dividends,
      fees,
      adjustments,
    };
  } catch (error) {
    error.message = `Account "${account.name}": ${error.message}`;
    throw error;
  }
}

function sumCounts(results) {
  const totals = {
    activitiesFetched: 0,
    activitiesInTaxYear: 0,
    realizedSales: 0,
    dividends: 0,
    fees: 0,
    adjustments: 0,
    fifoWarnings: 0,
  };

  for (const result of results) {
    for (const key of Object.keys(totals)) {
      totals[key] += result.counts[key] || 0;
    }
  }

  return totals;
}

function summarizeUsdTotals(sales) {
  let shortTermGain = 0;
  let shortTermLoss = 0;
  let longTermGain = 0;
  let longTermLoss = 0;

  for (const sale of sales) {
    const shortGainUsd = sumMatchedLotGainUsd(sale, "short_term");
    const longGainUsd = sumMatchedLotGainUsd(sale, "long_term");

    if (shortGainUsd >= 0) {
      shortTermGain += shortGainUsd;
    } else {
      shortTermLoss += Math.abs(shortGainUsd);
    }

    if (longGainUsd >= 0) {
      longTermGain += longGainUsd;
    } else {
      longTermLoss += Math.abs(longGainUsd);
    }
  }

  return {
    shortTermGain: round2(shortTermGain),
    shortTermLoss: round2(shortTermLoss),
    longTermGain: round2(longTermGain),
    longTermLoss: round2(longTermLoss),
    totalNet: round2(shortTermGain - shortTermLoss + longTermGain - longTermLoss),
    totalLosses: round2(shortTermLoss + longTermLoss),
  };
}

function sumMatchedLotGainUsd(sale, holdingPeriod) {
  return sale.matchedLots
    .filter((lot) => (lot.holdingPeriod || "short_term") === holdingPeriod)
    .reduce((total, lot) => total + (sale.quantity === 0 ? 0 : sale.gainUsd * (lot.quantity / sale.quantity)), 0);
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function activityYear(activity) {
  const source = activity.transaction_time || activity.date;
  return new Date(source).getUTCFullYear();
}

function loadDotEnv() {
  const envPath = path.resolve(".env");
  try {
    const raw = require("fs").readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const separator = trimmed.indexOf("=");
      if (separator === -1) {
        continue;
      }
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional if the shell already provides the variables.
  }
}

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const next = argv[i + 1];

    if (current === "--help" || current === "-h") {
      args.help = true;
      continue;
    }

    if (current === "--diagnose-auth") {
      args.diagnoseAuth = true;
      continue;
    }

    if (current === "--year") {
      args.year = next;
      i += 1;
      continue;
    }

    if (current === "--accounts") {
      args.accounts = next;
      i += 1;
      continue;
    }

    if (current === "--symbol-overrides") {
      args.symbolOverrides = next;
      i += 1;
      continue;
    }

    if (current === "--output-dir") {
      args.outputDir = next;
      i += 1;
      continue;
    }

    if (current === "--fx-cache-path") {
      args.fxCachePath = next;
      i += 1;
      continue;
    }

    if (current === "--history-start") {
      args.historyStart = next;
      i += 1;
    }
  }

  return args;
}

async function loadJsonFile(filePath) {
  if (!filePath) {
    return {};
  }

  const absolute = path.resolve(filePath);
  const text = await fs.readFile(absolute, "utf8");
  return JSON.parse(text);
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node src/cli.js --year 2025 [--accounts ./accounts.json] [--symbol-overrides ./symbol-overrides.json] [--output-dir ./output] [--history-start 2000-01-01]",
      "       node src/cli.js --year 2025 --diagnose-auth",
      "",
      "Accounts:",
      "  Single account: ALPACA_KEY_ID, ALPACA_SECRET_KEY, ALPACA_PAPER",
      "  Multiple via env: ALPACA_ACCOUNTS=account1,account2 plus ALPACA_ACCOUNT1_KEY_ID / ALPACA_ACCOUNT1_SECRET_KEY and ALPACA_ACCOUNT2_KEY_ID / ALPACA_ACCOUNT2_SECRET_KEY",
      "  Multiple via file: --accounts ./accounts.json",
    ].join("\n") + "\n"
  );
}

async function runAuthDiagnostic(accounts) {
  const diagnostics = {
    generatedAt: new Date().toISOString(),
    accounts: [],
  };

  for (const account of accounts) {
    const entry = {
      name: account.name,
      environment: getAlpacaEnvironment(account),
      env: {
        hasKeyId: Boolean(account.keyId),
        keyIdLength: (account.keyId || "").length,
        hasSecretKey: Boolean(account.secretKey),
        secretKeyLength: (account.secretKey || "").length,
        paper: Boolean(account.paper),
      },
    };

    let alpaca;
    try {
      alpaca = createAlpacaClient(account);
    } catch (error) {
      entry.createClient = serializeError(error);
      diagnostics.accounts.push(entry);
      continue;
    }

    try {
      const alpacaAccount = await alpaca.getAccount();
      entry.getAccount = {
        ok: true,
        accountNumberSuffix: String(alpacaAccount.account_number || "").slice(-4),
        status: alpacaAccount.status || null,
        currency: alpacaAccount.currency || null,
      };
    } catch (error) {
      entry.getAccount = serializeError(error);
      diagnostics.accounts.push(entry);
      continue;
    }

    try {
      const activities = await alpaca.getAccountActivities({
        direction: "desc",
        pageSize: 1,
      });
      entry.getAccountActivities = {
        ok: true,
        count: Array.isArray(activities) ? activities.length : null,
        sampleActivityType: Array.isArray(activities) && activities[0] ? activities[0].activity_type : null,
      };
    } catch (error) {
      entry.getAccountActivities = serializeError(error);
    }

    diagnostics.accounts.push(entry);
  }

  process.stdout.write(`${JSON.stringify(diagnostics, null, 2)}\n`);
}

function serializeError(error) {
  return {
    ok: false,
    name: error?.name || "Error",
    message: error?.message || String(error),
    status: error?.response?.status || null,
    statusText: error?.response?.statusText || null,
    responseData: error?.response?.data || null,
  };
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
