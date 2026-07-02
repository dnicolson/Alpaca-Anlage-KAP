function parseNumber(value, defaultValue = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : defaultValue;
}

function activityTimestamp(activity) {
  return activity.transaction_time || activity.date;
}

function compareByActivityTime(a, b) {
  return new Date(activityTimestamp(a)).getTime() - new Date(activityTimestamp(b)).getTime();
}

function buildRealizedSales(tradeActivities, options = {}) {
  const { reportYear } = options;
  const positionsBySymbol = new Map();
  const realizedSales = [];
  const warnings = [];

  for (const activity of [...tradeActivities].sort(compareByActivityTime)) {
    const symbol = activity.symbol;
    const side = String(activity.side || "").toLowerCase();
    const qty = parseNumber(activity.qty);
    const price = parseNumber(activity.price);
    const when = activity.transaction_time;

    if (!symbol || !qty || !price || !when) {
      continue;
    }

    if (!positionsBySymbol.has(symbol)) {
      positionsBySymbol.set(symbol, { longLots: [], shortLots: [] });
    }

    const position = positionsBySymbol.get(symbol);

    if (side === "buy") {
      let remainingQty = qty;

      while (remainingQty > 1e-12 && position.shortLots.length > 0) {
        const shortLot = position.shortLots[0];
        const matchedQty = Math.min(remainingQty, shortLot.remainingQty);
        const basisUsd = matchedQty * shortLot.priceUsd;
        const proceedsUsd = matchedQty * price;

        realizedSales.push({
          symbol,
          soldAt: shortLot.acquiredAt,
          quantity: matchedQty,
          sellPriceUsd: shortLot.priceUsd,
          proceedsUsd: basisUsd,
          basisUsd: proceedsUsd,
          gainUsd: basisUsd - proceedsUsd,
          matchedLots: [
            {
              buyActivityId: activity.id,
              acquiredAt: when,
              quantity: matchedQty,
              buyPriceUsd: price,
              basisUsd: proceedsUsd,
              shortCover: true,
            },
          ],
          sellActivityId: shortLot.activityId,
          positionType: "short",
          closedAt: when,
        });

        shortLot.remainingQty -= matchedQty;
        remainingQty -= matchedQty;

        if (shortLot.remainingQty <= 1e-12) {
          position.shortLots.shift();
        }
      }

      if (remainingQty > 1e-12) {
        position.longLots.push({
          acquiredAt: when,
          remainingQty,
          priceUsd: price,
          activityId: activity.id,
        });
      }

      continue;
    }

    if (side === "sell" || side === "sell_short") {
      let remainingQty = qty;
      const matchedLots = [];
      let totalBasisUsd = 0;
      let totalProceedsUsd = 0;

      if (side === "sell") {
        while (remainingQty > 1e-12 && position.longLots.length > 0) {
          const longLot = position.longLots[0];
          const matchedQty = Math.min(remainingQty, longLot.remainingQty);
          const basisUsd = matchedQty * longLot.priceUsd;
          const proceedsUsd = matchedQty * price;

          matchedLots.push({
            buyActivityId: longLot.activityId,
            acquiredAt: longLot.acquiredAt,
            quantity: matchedQty,
            buyPriceUsd: longLot.priceUsd,
            basisUsd,
          });

          totalBasisUsd += basisUsd;
          totalProceedsUsd += proceedsUsd;
          longLot.remainingQty -= matchedQty;
          remainingQty -= matchedQty;

          if (longLot.remainingQty <= 1e-12) {
            position.longLots.shift();
          }
        }

        if (remainingQty > 1e-12) {
          const saleYear = new Date(when).getUTCFullYear();
          const canUseHistoricalCarryIn = Number.isInteger(reportYear) && saleYear < reportYear;

          if (canUseHistoricalCarryIn) {
            const basisUsd = remainingQty * price;
            const proceedsUsd = remainingQty * price;
            matchedLots.push({
              buyActivityId: null,
              acquiredAt: when,
              quantity: remainingQty,
              buyPriceUsd: price,
              basisUsd,
              synthetic: true,
            });
            totalBasisUsd += basisUsd;
            totalProceedsUsd += proceedsUsd;
            warnings.push(
              `Historical FIFO gap for ${symbol} on ${when}: synthesized ${remainingQty} units of carry-in basis before report year ${reportYear}.`
            );
            remainingQty = 0;
          } else {
            position.shortLots.push({
              acquiredAt: when,
              remainingQty,
              priceUsd: price,
              activityId: activity.id,
            });
          }
        }

        if (matchedLots.length > 0) {
          realizedSales.push({
            symbol,
            soldAt: when,
            quantity: matchedLots.reduce((total, lot) => total + lot.quantity, 0),
            sellPriceUsd: price,
            proceedsUsd: totalProceedsUsd,
            basisUsd: totalBasisUsd,
            gainUsd: totalProceedsUsd - totalBasisUsd,
            matchedLots,
            sellActivityId: activity.id,
            positionType: "long",
          });
        }

        continue;
      }

      position.shortLots.push({
        acquiredAt: when,
        remainingQty,
        priceUsd: price,
        activityId: activity.id,
      });
    }
  }

  return {
    realizedSales,
    warnings,
  };
}

module.exports = {
  buildRealizedSales,
  parseNumber,
};
