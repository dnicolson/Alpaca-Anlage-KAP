const fs = require("fs/promises");
const path = require("path");

const LEGACY_ACCOUNT_NAME = "Default";

function normalizeEnvName(name) {
  return String(name)
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function parsePaper(value, fallback) {
  if (value == null || value === "") {
    return fallback;
  }

  return String(value).toLowerCase() === "true";
}

function envCredentialName(accountName, kind) {
  const suffix = kind === "keyId" ? "KEY_ID" : "SECRET_KEY";
  return `ALPACA_${normalizeEnvName(accountName)}_${suffix}`;
}

function resolveCredential(entry, kind, env) {
  const envField = `${kind}Env`;

  if (entry[envField]) {
    return env[entry[envField]] || entry[kind];
  }

  if (entry[kind]) {
    return entry[kind];
  }

  return env[envCredentialName(entry.name, kind)];
}

function resolvePaper(entry, env, fallback) {
  if (entry.paper != null && entry.paper !== "") {
    return parsePaper(entry.paper, fallback);
  }

  const accountPaper = env[`ALPACA_${normalizeEnvName(entry.name)}_PAPER`];
  return parsePaper(accountPaper, fallback);
}

function validateAccounts(accounts) {
  const seen = new Set();

  for (const account of accounts) {
    if (!account.name) {
      throw new Error("Every Alpaca account needs a non-empty name.");
    }

    if (!normalizeEnvName(account.name)) {
      throw new Error(`Alpaca account name "${account.name}" must contain at least one letter or digit.`);
    }

    const key = account.name.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Duplicate Alpaca account name: ${account.name}`);
    }
    seen.add(key);

    if (!account.keyId || !account.secretKey) {
      throw new Error(
        `Missing credentials for Alpaca account "${account.name}". Set keyId/keyIdEnv and secretKey/secretKeyEnv, or ALPACA_${normalizeEnvName(
          account.name
        )}_KEY_ID / ALPACA_${normalizeEnvName(account.name)}_SECRET_KEY.`
      );
    }
  }

  return accounts;
}

function buildAccount(entry, env, defaultPaper) {
  const normalized = typeof entry === "string" ? { name: entry } : entry;

  if (!normalized || typeof normalized !== "object") {
    throw new Error("Account entries must be strings or objects.");
  }

  return {
    name: String(normalized.name || "").trim(),
    keyId: resolveCredential(normalized, "keyId", env),
    secretKey: resolveCredential(normalized, "secretKey", env),
    paper: resolvePaper(normalized, env, defaultPaper),
  };
}

async function loadAccounts({ accountsPath, env = process.env, cwd = process.cwd() } = {}) {
  if (accountsPath) {
    const absolute = path.resolve(cwd, accountsPath);
    const text = await fs.readFile(absolute, "utf8");
    const parsed = JSON.parse(text);
    const entries = Array.isArray(parsed) ? parsed : parsed.accounts;

    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error(`No accounts defined in ${absolute}. Expected an array or { "accounts": [...] }.`);
    }

    const defaultPaper = parsePaper(env.ALPACA_PAPER, false);
    return validateAccounts(entries.map((entry) => buildAccount(entry, env, defaultPaper)));
  }

  const listed = String(env.ALPACA_ACCOUNTS || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  const defaultPaper = parsePaper(env.ALPACA_PAPER, false);

  if (listed.length > 0) {
    return validateAccounts(listed.map((name) => buildAccount({ name }, env, defaultPaper)));
  }

  if (env.ALPACA_KEY_ID && env.ALPACA_SECRET_KEY) {
    return validateAccounts([
      {
        name: env.ALPACA_ACCOUNT_NAME || LEGACY_ACCOUNT_NAME,
        keyId: env.ALPACA_KEY_ID,
        secretKey: env.ALPACA_SECRET_KEY,
        paper: defaultPaper,
      },
    ]);
  }

  throw new Error(
    "No Alpaca accounts configured. Set ALPACA_KEY_ID and ALPACA_SECRET_KEY, or ALPACA_ACCOUNTS plus per-account variables, or pass --accounts ./accounts.json."
  );
}

module.exports = {
  loadAccounts,
  normalizeEnvName,
};
