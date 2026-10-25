const { parseNumber } = require("./fifo");

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function toIsoDate(input) {
  return String(input).slice(0, 10);
}

function isLongTerm(acquiredAt, soldAt) {
  const acquired = new Date(acquiredAt);
  const sold = new Date(soldAt);
  return sold.getTime() - acquired.getTime() > 365 * 24 * 60 * 60 * 1000;
}

function defaultClassification(asset) {
  const assetClass = String(asset?.class || "").toLowerCase();
  const name = String(asset?.name || "").toLowerCase();

  if (assetClass.includes("crypto")) {
    return { type: "crypto", domestic: false };
  }

  if (/\betf\b|\bfund\b|ishares|vanguard|spdr|invesco/.test(name)) {
    return { type: "etf", domestic: false };
  }

  return { type: "stock", domestic: false };
}

function buildClassifier(overridesBySymbol, assetsBySymbol) {
  return (symbol) => {
    if (overridesBySymbol[symbol]) {
      return overridesBySymbol[symbol];
    }
    return defaultClassification(assetsBySymbol.get(symbol));
  };
}

function sum(items, selector) {
  return items.reduce((total, item) => total + selector(item), 0);
}

function buildAdjustedCashActivities(activities, fx) {
  return activities.map((activity) => {
    const isoDate = toIsoDate(activity.date || activity.transaction_time);
    const amountUsd = parseNumber(activity.net_amount);
    return {
      ...activity,
      isoDate,
      amountUsd,
      amountEur: fx.usdToEur(isoDate, amountUsd),
    };
  });
}

function enrichRealizedSales(realizedSales, fx, classifySymbol) {
  return realizedSales.map((sale) => {
    const taxableEventAt = sale.closedAt || sale.soldAt;
    const sellDate = toIsoDate(taxableEventAt);
    const proceedsFxDate = sale.positionType === "short" ? toIsoDate(sale.soldAt) : sellDate;
    const proceedsEur = fx.usdToEur(proceedsFxDate, sale.proceedsUsd);

    let basisEur = 0;
    let longTermGainEur = 0;
    let shortTermGainEur = 0;

    const matchedLots = sale.matchedLots.map((lot) => {
      const buyDate = sale.positionType === "short" ? sellDate : toIsoDate(lot.acquiredAt);
      const basisEurPart = fx.usdToEur(buyDate, lot.basisUsd);
      basisEur += basisEurPart;
      return {
        ...lot,
        basisEur: basisEurPart,
        holdingPeriod: isLongTerm(lot.acquiredAt, taxableEventAt) ? "long_term" : "short_term",
      };
    });

    const gainEur = proceedsEur - basisEur;

    for (const lot of matchedLots) {
      const proportion = sale.quantity === 0 ? 0 : lot.quantity / sale.quantity;
      const allocatedGain = gainEur * proportion;
      if (lot.holdingPeriod === "long_term") {
        longTermGainEur += allocatedGain;
      } else {
        shortTermGainEur += allocatedGain;
      }
    }

    return {
      ...sale,
      assetType: classifySymbol(sale.symbol).type,
      domestic: Boolean(classifySymbol(sale.symbol).domestic),
      sellDate,
      taxableEventAt,
      proceedsEur,
      basisEur,
      gainEur,
      shortTermGainEur,
      longTermGainEur,
      matchedLots,
    };
  });
}

function summarize({ sales, dividends, fees, adjustments }) {
  const stockSales = sales.filter((sale) => sale.assetType === "stock");
  const etfSales = sales.filter((sale) => sale.assetType === "etf");
  const cryptoSales = sales.filter((sale) => sale.assetType === "crypto");

  const stockDomesticSales = stockSales.filter((sale) => sale.domestic);
  const stockForeignSales = stockSales.filter((sale) => !sale.domestic);

  const stockDividends = dividends.filter((item) => item.assetType === "stock");
  const etfDividends = dividends.filter((item) => item.assetType === "etf");
  const cryptoDividends = dividends.filter((item) => item.assetType === "crypto");

  const positive = (value) => (value > 0 ? value : 0);
  const negative = (value) => (value < 0 ? value : 0);

  const kap = {
    "18. Inländische Kapitalerträge": round2(sum(stockDomesticSales, (x) => x.gainEur)),
    "19. Ausländische Kapitalerträge": round2(
      sum(stockForeignSales, (x) => x.gainEur) +
        sum(stockDividends, (x) => x.amountEur) +
        sum(etfSales, (x) => x.gainEur) +
        sum(etfDividends, (x) => x.amountEur) +
        sum(fees, (x) => x.amountEur) +
        sum(adjustments, (x) => x.amountEur)
    ),
    "19.   - Ausländische Aktien G/W": round2(sum(stockForeignSales, (x) => x.gainEur)),
    "19.   - Ausländische Aktien Dividende": round2(sum(stockDividends, (x) => x.amountEur)),
    "19.   - ETF G/W": round2(sum(etfSales, (x) => x.gainEur)),
    "19.   - ETF Dividende": round2(sum(etfDividends, (x) => x.amountEur)),
    "19.   - Gebühren": round2(sum(fees, (x) => x.amountEur)),
    "19.   - Sonstige Anpassungen": round2(sum(adjustments, (x) => x.amountEur)),
    "20. Enthaltene Gewinne aus Aktienveräußerungen": round2(
      sum(stockSales, (x) => positive(x.gainEur))
    ),
    "21. Enthaltene Einkünfte aus Termingeschäften / sonstigen positiven Beiträgen": round2(0),
    "22. Enthaltene Verluste ohne Verluste aus Aktienveräußerungen": round2(
      sum(etfSales, (x) => negative(x.gainEur))
    ),
    "23. Enthaltene Verluste aus Aktienveräußerungen": round2(
      sum(stockSales, (x) => negative(x.gainEur))
    ),
    "24. Verluste aus Termingeschäften": round2(0),
  };

  const so = {
    "44. Veräußerungspreis oder an dessen Stelle tretender Wert": round2(
      sum(cryptoSales, (x) => x.proceedsEur)
    ),
    "45. Anschaffungskosten": round2(sum(cryptoSales, (x) => x.basisEur)),
    "47. Gewinn / Verlust": round2(sum(cryptoSales, (x) => x.gainEur) + sum(cryptoDividends, (x) => x.amountEur)),
  };

  return {
    kap,
    so,
  };
}

module.exports = {
  buildAdjustedCashActivities,
  buildClassifier,
  enrichRealizedSales,
  summarize,
};
