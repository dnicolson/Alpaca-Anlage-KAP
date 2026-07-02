const fs = require("fs/promises");
const path = require("path");

const DEFAULT_BUNDESBANK_URL =
  "https://api.statistiken.bundesbank.de/rest/data/BBEX3/D.USD.EUR.BB.AC.000?format=sdmx_csv&detail=dataonly&startPeriod=1999-01-01";

function looksLikeHtml(text) {
  return /^\s*<!DOCTYPE html/i.test(text) || /^\s*<html/i.test(text);
}

async function ensureBundesbankCsv(cachePath) {
  try {
    const existing = await fs.readFile(cachePath, "utf8");
    if (!looksLikeHtml(existing) && existing.trim()) {
      return;
    }
  } catch {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
  }

  const response = await fetch(process.env.BUNDESBANK_USD_EUR_CSV_URL || DEFAULT_BUNDESBANK_URL, {
    headers: {
      Accept: "text/csv,application/vnd.sdmx.data+csv;version=1.0.0;q=0.9,*/*;q=0.1",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download Bundesbank FX data: HTTP ${response.status}`);
  }

  const text = await response.text();
  if (looksLikeHtml(text)) {
    throw new Error(
      "Bundesbank FX download returned HTML instead of data. Check BUNDESBANK_USD_EUR_CSV_URL or network access."
    );
  }
  await fs.writeFile(cachePath, text, "utf8");
}

function parseBundesbankNumber(raw) {
  if (!raw || raw === ".") {
    return null;
  }

  const trimmed = String(raw).trim();
  const normalized = trimmed.includes(",")
    ? trimmed.replace(/\./g, "").replace(",", ".")
    : trimmed;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function parseBundesbankCsv(text) {
  if (looksLikeHtml(text)) {
    throw new Error("Bundesbank FX cache contains HTML instead of CSV data.");
  }

  const rates = new Map();
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  const headerIndex = lines.findIndex((line) => /TIME_PERIOD/i.test(line) && /OBS_VALUE/i.test(line));
  if (headerIndex !== -1) {
    const delimiter = detectDelimiter(lines[headerIndex]);
    const headers = splitDelimitedLine(lines[headerIndex], delimiter);
    const timePeriodIndex = headers.findIndex((value) => /^TIME_PERIOD$/i.test(unquote(value)));
    const obsValueIndex = headers.findIndex((value) => /^OBS_VALUE$/i.test(unquote(value)));

    if (timePeriodIndex !== -1 && obsValueIndex !== -1) {
      for (const line of lines.slice(headerIndex + 1)) {
        const columns = splitDelimitedLine(line, delimiter);
        const date = unquote(columns[timePeriodIndex] || "");
        const value = parseBundesbankNumber(unquote(columns[obsValueIndex] || ""));

        if (/^\d{4}-\d{2}-\d{2}$/.test(date) && value !== null) {
          rates.set(date, value);
        }
      }
    }
  }

  if (rates.size > 0) {
    return rates;
  }

  for (const line of lines) {
    if (!line.includes(";")) {
      continue;
    }

    const [date, value] = line.split(";");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      continue;
    }

    const parsedValue = parseBundesbankNumber(value);
    if (parsedValue !== null) {
      rates.set(date, parsedValue);
    }
  }

  if (rates.size === 0) {
    throw new Error("No FX rates parsed from Bundesbank CSV.");
  }

  return rates;
}

function detectDelimiter(line) {
  const semicolons = (line.match(/;/g) || []).length;
  const commas = (line.match(/,/g) || []).length;
  return semicolons >= commas ? ";" : ",";
}

function splitDelimitedLine(line, delimiter) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function unquote(value) {
  return String(value).trim().replace(/^"(.*)"$/, "$1");
}

function previousDay(isoDate) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function createFxConverter(rates) {
  function getUsdPerEur(isoDate) {
    let probe = isoDate;

    for (let i = 0; i < 7; i += 1) {
      const rate = rates.get(probe);
      if (rate) {
        return rate;
      }
      probe = previousDay(probe);
    }

    throw new Error(`Missing USD/EUR FX rate for ${isoDate} and previous business days.`);
  }

  function usdToEur(isoDate, amountUsd) {
    const rate = getUsdPerEur(isoDate);
    return amountUsd / rate;
  }

  return {
    usdToEur,
  };
}

async function loadFxConverter(cachePath = path.join(".cache", "bundesbank-usd-eur.csv")) {
  await ensureBundesbankCsv(cachePath);
  const text = await fs.readFile(cachePath, "utf8");
  return createFxConverter(parseBundesbankCsv(text));
}

module.exports = {
  loadFxConverter,
};
