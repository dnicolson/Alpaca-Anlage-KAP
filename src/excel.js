const path = require("path");
const XLSX = require("xlsx");

const RESERVED_SHEET_NAMES = ["Gesamt", "Konten", "Verkaeufe", "Lots", "Zahlungen"];

function writeWorkbook({ year, outputDir, summaryPayload, accounts }) {
  const workbook = XLSX.utils.book_new();

  const total = summaryPayload.total || {
    summary: summaryPayload.summary,
    usdTotals: summaryPayload.usdTotals,
    warnings: summaryPayload.warnings,
    counts: summaryPayload.counts,
  };

  const summaryRows = [
    ...objectToRows(total.summary.kap, "Anlage KAP (Gesamt)"),
    [],
    ...objectToRows(total.summary.so, "Anlage SO (Gesamt)"),
    [],
    ...(total.warnings || []).map((warning) => ({ bereich: "Hinweise", bezeichnung: warning, wert: "" })),
  ];

  const accountRows = [
    ...accounts.map((account) =>
      buildAccountTotalsRow(account.name, account.summary, account.usdTotals, account.counts, account.warnings)
    ),
    buildAccountTotalsRow("Gesamt", total.summary, total.usdTotals, total.counts, total.warnings),
  ];

  const salesRows = accounts.flatMap((account) =>
    account.realizedSales.map((sale) => ({
      konto: account.name,
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
    }))
  );

  const lotRows = accounts.flatMap((account) =>
    account.realizedSales.flatMap((sale) =>
      sale.matchedLots.map((lot) => ({
        konto: account.name,
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
    )
  );

  const cashRows = accounts.flatMap((account) => [
    ...mapCashRows(account.dividends, "dividend", account.name),
    ...mapCashRows(account.fees, "fee", account.name),
    ...mapCashRows(account.adjustments, "adjustment", account.name),
  ]);

  const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
  const accountsSheet = XLSX.utils.json_to_sheet(accountRows);
  const salesSheet = XLSX.utils.json_to_sheet(salesRows);
  const lotsSheet = XLSX.utils.json_to_sheet(lotRows);
  const cashSheet = XLSX.utils.json_to_sheet(cashRows);

  summarySheet["!cols"] = autoWidth(summaryRows, 18, 72);
  accountsSheet["!cols"] = autoWidth(accountRows, 12, 32);
  salesSheet["!cols"] = autoWidth(salesRows, 12, 24);
  lotsSheet["!cols"] = autoWidth(lotRows, 12, 24);
  cashSheet["!cols"] = autoWidth(cashRows, 12, 24);

  const usedSheetNames = new Set(RESERVED_SHEET_NAMES.map((name) => name.toLowerCase()));

  XLSX.utils.book_append_sheet(workbook, summarySheet, "Gesamt");
  XLSX.utils.book_append_sheet(workbook, accountsSheet, "Konten");

  for (const account of accounts) {
    const rows = [
      ...objectToRows(account.summary.kap, "Anlage KAP"),
      [],
      ...objectToRows(account.summary.so, "Anlage SO"),
      [],
      ...account.warnings.map((warning) => ({ bereich: "Hinweise", bezeichnung: warning, wert: "" })),
    ];
    const sheet = XLSX.utils.json_to_sheet(rows);
    sheet["!cols"] = autoWidth(rows, 18, 72);
    XLSX.utils.book_append_sheet(workbook, sheet, createSheetName(account.name, usedSheetNames));
  }

  XLSX.utils.book_append_sheet(workbook, salesSheet, "Verkaeufe");
  XLSX.utils.book_append_sheet(workbook, lotsSheet, "Lots");
  XLSX.utils.book_append_sheet(workbook, cashSheet, "Zahlungen");

  const filePath = path.join(outputDir, `${year}_FIFO_Berechnung.xlsx`);
  XLSX.writeFile(workbook, filePath);
  return filePath;
}

function buildAccountTotalsRow(name, summary, usdTotals, counts, warnings) {
  return {
    konto: name,
    anlage_kap_18: summary.kap["18. Inländische Kapitalerträge"],
    anlage_kap_19: summary.kap["19. Ausländische Kapitalerträge"],
    anlage_kap_20: summary.kap["20. Enthaltene Gewinne aus Aktienveräußerungen"],
    anlage_kap_22: summary.kap["22. Enthaltene Verluste ohne Verluste aus Aktienveräußerungen"],
    anlage_kap_23: summary.kap["23. Enthaltene Verluste aus Aktienveräußerungen"],
    anlage_so_44: summary.so["44. Veräußerungspreis oder an dessen Stelle tretender Wert"],
    anlage_so_45: summary.so["45. Anschaffungskosten"],
    anlage_so_47: summary.so["47. Gewinn / Verlust"],
    realisierte_verkaeufe: counts.realizedSales,
    dividenden: counts.dividends,
    gebuehren: counts.fees,
    anpassungen: counts.adjustments,
    netto_usd: usdTotals.totalNet,
    warnungen: warnings.length,
  };
}

function objectToRows(source, section) {
  return Object.entries(source).map(([label, value]) => ({
    bereich: section,
    bezeichnung: label,
    wert: value,
  }));
}

function mapCashRows(items, category, accountName) {
  return items.map((item) => ({
    konto: accountName,
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

function createSheetName(rawName, usedNames) {
  const base =
    String(rawName)
      .replace(/[\[\]:*?\/\\]/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Konto";

  let candidate = base.slice(0, 31);
  let counter = 2;

  while (usedNames.has(candidate.toLowerCase())) {
    const suffix = ` ${counter}`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    counter += 1;
  }

  usedNames.add(candidate.toLowerCase());
  return candidate;
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
