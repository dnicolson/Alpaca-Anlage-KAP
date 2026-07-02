const Alpaca = require("@alpacahq/alpaca-trade-api");

function createAlpacaClient() {
  const keyId = process.env.ALPACA_KEY_ID;
  const secretKey = process.env.ALPACA_SECRET_KEY;
  const paper = String(process.env.ALPACA_PAPER || "false").toLowerCase() === "true";
  const baseUrl = paper ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets";

  if (!keyId || !secretKey) {
    throw new Error("Missing ALPACA_KEY_ID or ALPACA_SECRET_KEY in environment.");
  }

  return new Alpaca({
    keyId,
    secretKey,
    paper,
    baseUrl,
  });
}

function getAlpacaEnvironment() {
  const paper = String(process.env.ALPACA_PAPER || "false").toLowerCase() === "true";
  return {
    paper,
    baseUrl: paper ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets",
  };
}

async function getAllActivities(alpaca, { after, until, pageSize = 100 }) {
  const activities = [];
  let pageToken;

  while (true) {
    const page = await alpaca.getAccountActivities({
      after,
      until,
      direction: "asc",
      pageSize,
      pageToken,
    });

    if (!Array.isArray(page) || page.length === 0) {
      break;
    }

    activities.push(...page);
    pageToken = page[page.length - 1].id;

    if (page.length < pageSize) {
      break;
    }
  }

  return activities;
}

async function getAssetMetadata(alpaca, symbolCache, symbol) {
  if (!symbol) {
    return null;
  }

  if (symbolCache.has(symbol)) {
    return symbolCache.get(symbol);
  }

  try {
    const asset = await alpaca.getAsset(symbol);
    symbolCache.set(symbol, asset);
    return asset;
  } catch (error) {
    const fallback = { symbol, class: inferFallbackClass(symbol), name: symbol };
    symbolCache.set(symbol, fallback);
    return fallback;
  }
}

function inferFallbackClass(symbol) {
  if (/(USD|USDT|BTC|ETH|SOL)$/i.test(symbol)) {
    return "crypto";
  }
  return "us_equity";
}

module.exports = {
  createAlpacaClient,
  getAllActivities,
  getAssetMetadata,
  getAlpacaEnvironment,
};
