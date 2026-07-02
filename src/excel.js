const path = require("path");
const XLSX = require("xlsx");

function writeWorkbook({
  year,
  outputDir,
  summaryPayload,
  realizedSales,
  dividends,
  fees,
  adjustments,
}) {
  const workbook = XLSX.utils.book_new();

  const summaryRows = [
    ...objectToRows(summaryPayload.summary.kap, "Anlage KAP"),
    [],
    ...objectToRows(summaryPayload.summary.so, "Anlage SO"),
    [],
    ...summaryPayload.warnings.map((warning) => ({ bereich: "Hinweise", bezeichnung: warning, wert: "" })),
  ];

  const salesRows = realizedSales.map((sale) => ({
    symbol: sale.symbol,
    verkauf_am: sale.soldAt,
    stueckzahl: sale.quantity,
    verkaufskurs_usd: sale.sellPriceUsd,
    erloes_usd: sale.proceedsUsd,
    anschaffungskosten_usd: sale.basisUsd,
    gewinn_verlust_usd: sale.gainUsd,
    erloes_eur: sale.proceedsEur,
    anschaffungskosten_eur: sale.basisEur,
    gewinn_verlust_eur: sale.gainEur,
    kurzfristig_eur: sale.shortTermGainEur,
    langfristig_eur: sale.longTermGainEur,
    positionstyp: sale.positionType,
    wertpapierart: sale.assetType,
    inlaendisch: sale.domestic,
    zugeordnete_lots: sale.matchedLots.length,
  }));

  const lotRows = realizedSales.flatMap((sale) =>
    sale.matchedLots.map((lot) => ({
      symbol: sale.symbol,
      verkauf_am: sale.soldAt,
      kauf_aktivitaet_id: lot.buyActivityId,
      angeschafft_am: lot.acquiredAt,
      stueckzahl: lot.quantity,
      kaufkurs_usd: lot.buyPriceUsd,
      anschaffungskosten_usd: lot.basisUsd,
      anschaffungskosten_eur: lot.basisEur || null,
      haltedauer: lot.holdingPeriod || null,
      synthetisch: Boolean(lot.synthetic),
    }))
  );

  const cashRows = [
    ...mapCashRows(dividends, "dividend"),
    ...mapCashRows(fees, "fee"),
    ...mapCashRows(adjustments, "adjustment"),
  ];

  const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
  const salesSheet = XLSX.utils.json_to_sheet(salesRows);
  const lotsSheet = XLSX.utils.json_to_sheet(lotRows);
  const cashSheet = XLSX.utils.json_to_sheet(cashRows);

  summarySheet["!cols"] = autoWidth(summaryRows, 18, 72);
  salesSheet["!cols"] = autoWidth(salesRows, 12, 24);
  lotsSheet["!cols"] = autoWidth(lotRows, 12, 24);
  cashSheet["!cols"] = autoWidth(cashRows, 12, 24);

  XLSX.utils.book_append_sheet(workbook, summarySheet, "Zusammenfassung");
  XLSX.utils.book_append_sheet(workbook, salesSheet, "Verkaeufe");
  XLSX.utils.book_append_sheet(workbook, lotsSheet, "Lots");
  XLSX.utils.book_append_sheet(workbook, cashSheet, "Zahlungen");

  const filePath = path.join(outputDir, `${year}_FIFO_Berechnung.xlsx`);
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function objectToRows(source, section) {
  return Object.entries(source).map(([label, value]) => ({
    bereich: section,
    bezeichnung: label,
    wert: value,
  }));
}

function mapCashRows(items, category) {
  return items.map((item) => ({
    kategorie: translateCategory(category),
    aktivitaetstyp: item.activity_type || null,
    symbol: item.symbol || null,
    datum: item.isoDate,
    betrag_usd: item.amountUsd,
    betrag_eur: item.amountEur,
    wertpapierart: item.assetType,
    inlaendisch: item.domestic,
  }));
}

function translateCategory(category) {
  if (category === "dividend") return "Dividende";
  if (category === "fee") return "Gebuehr";
  if (category === "adjustment") return "Anpassung";
  return category;
}

function autoWidth(rows, min = 10, max = 40) {
  if (!rows.length) {
    return [];
  }

  const keys = Object.keys(rows[0]);
  return keys.map((key) => {
    const values = [key, ...rows.map((row) => row[key] == null ? "" : String(row[key]))];
    const width = values.reduce((largest, value) => Math.max(largest, value.length), 0);
    return { wch: Math.max(min, Math.min(max, width + 2)) };
  });
}

module.exports = {
  writeWorkbook,
};
