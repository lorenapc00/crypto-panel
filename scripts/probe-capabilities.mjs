import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const at = (value, path) => (Array.isArray(path) ? path : String(path).split(".")).reduce((v, key) => v?.[key], value);
const numeric = value => (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) && Number.isFinite(Number(value));
const timestamp = (value, unit) => unit === "iso" ? (typeof value === "string" ? Date.parse(value) : NaN) : numeric(value) ? Number(value) * (unit === "s" ? 1000 : 1) : NaN;
const iso = value => Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? new Date(value).toISOString() : null;

export function seriesSummary(rows, spec) {
  if (!Array.isArray(rows)) throw new Error("Expected a time-series array");
  const times = rows.map(row => timestamp(at(row, spec.time), spec.unit));
  const valid = times.filter(time => iso(time) !== null);
  const sorted = [...new Set(valid)].sort((a, b) => a - b);
  const intervals = new Map();
  for (let i = 1; i < sorted.length; i++) {
    const seconds = (sorted[i] - sorted[i - 1]) / 1000;
    intervals.set(seconds, (intervals.get(seconds) ?? 0) + 1);
  }
  const histogram = [...intervals].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const metrics = Object.fromEntries((spec.metrics ?? []).map(metric => {
    const populated = rows.flatMap((row, index) => numeric(at(row, metric)) && iso(times[index]) !== null ? [times[index]] : []).sort((a, b) => a - b);
    return [metric, { numericRows: populated.length, missingRows: rows.length - populated.length, first: iso(populated[0]), last: iso(populated.at(-1)) }];
  }));
  return {
    rows: rows.length, first: iso(sorted[0]), last: iso(sorted.at(-1)),
    invalidTimestamps: rows.length - valid.length, duplicateTimestamps: valid.length - sorted.length,
    ascending: valid.every((time, index) => index === 0 || time > valid[index - 1]),
    regular: histogram.length === 1 && rows.length === valid.length && valid.length === sorted.length,
    intervalSeconds: histogram.length === 1 ? histogram[0][0] : null,
    intervalHistogram: histogram.map(([seconds, count]) => ({ seconds, count })), metrics,
  };
}

export function summarize(payload, spec) {
  if (spec.kind === "csv") {
    // Coin Metrics archives contain unquoted dates/numbers. Fail visibly if that contract changes.
    if (payload.includes('"')) throw new Error("Quoted CSV requires a CSV parser");
    const [header, ...lines] = payload.trim().split(/\r?\n/);
    const columns = header.split(",");
    if (columns[0] !== "time") throw new Error("Missing CSV time column");
    const rows = lines.map(line => {
      const values = line.split(",");
      if (values.length !== columns.length) throw new Error("Inconsistent CSV column count");
      return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
    });
    return { columns, ...seriesSummary(rows, { time: "time", unit: "iso", metrics: spec.metrics }) };
  }
  if (spec.kind === "integer") {
    if (!/^\d+$/.test(payload.trim())) throw new Error("Expected integer text");
    return { value: Number(payload) };
  }
  if (payload === null || typeof payload !== "object" || payload.error || payload.error_code || payload.status?.error_code) throw new Error("Provider returned an error or invalid payload");
  if (spec.kind === "series") return seriesSummary(at(payload, spec.path), spec);
  if (spec.kind === "cg-chart") return Object.fromEntries(["prices", "market_caps", "total_volumes"].map(key => [key, seriesSummary(payload[key], { time: 0, unit: "ms", metrics: ["1"] })]));
  if (spec.kind === "object") {
    for (const path of spec.required) if (at(payload, path) === undefined || at(payload, path) === null) throw new Error(`Missing field: ${path}`);
    return { fields: Object.fromEntries(spec.required.map(path => [path, at(payload, path)])) };
  }
  if (spec.kind === "namespaces") {
    if (!Array.isArray(payload) || payload[0] !== null || payload.slice(1).some(row => typeof row?.name !== "string" || !row.name)) throw new Error("Unexpected perp DEX namespace catalog");
    return { namespaces: payload.map((row, index) => ({ index, name: row?.name ?? "" })) };
  }
  if (spec.kind === "contexts") {
    if (!Array.isArray(payload?.[0]?.universe) || !Array.isArray(payload[1]) || payload[0].universe.length !== payload[1].length) throw new Error("Metadata/context arrays do not align");
    return {
      instruments: payload[0].universe.map((row, index) => ({ index, name: row.name, delisted: row.isDelisted ?? false })),
      contexts: summarize(payload[1], { kind: "rows", path: [], fields: ["openInterest", "markPx", "oraclePx", "funding", "dayNtlVlm", "impactPxs"] }),
    };
  }
  if (spec.kind === "book") {
    if (!Array.isArray(payload.levels) || payload.levels.length !== 2 || payload.levels.some(side => !Array.isArray(side))) throw new Error("Expected two order-book sides");
    return { coin: payload.coin, observedAt: iso(payload.time), levelsPerSide: payload.levels.map(side => side.length), bestBid: payload.levels[0][0] ?? null, bestAsk: payload.levels[1][0] ?? null };
  }
  if (spec.kind === "llama") {
    if (!Array.isArray(payload.totalDataChart) || !Array.isArray(payload.protocols) && typeof payload.name !== "string") throw new Error("Missing DefiLlama summary/chart");
    return {
      name: payload.name ?? null, dataType: payload.dataType ?? null, total24h: payload.total24h ?? null,
      protocols: payload.protocols?.map(row => ({ name: row.name, id: row.defillamaId ?? row.slug ?? null })) ?? null,
      history: seriesSummary(payload.totalDataChart, { time: 0, unit: "s", metrics: ["1"] }),
    };
  }
  if (spec.kind === "rows") {
    const rows = at(payload, spec.path);
    if (!Array.isArray(rows)) throw new Error("Expected a collection array");
    return { rows: rows.length, fields: Object.fromEntries((spec.fields ?? []).map(field => [field, { presentRows: rows.filter(row => at(row, field) !== undefined && at(row, field) !== null).length }])), sampleIds: rows.slice(0, 3).map(row => row.id ?? row.slug ?? row.pairAddress ?? row.tokenAddress ?? null) };
  }
  throw new Error(`Unknown summary kind: ${spec.kind}`);
}

export async function probe(spec, { fetchImpl = fetch, env = process.env, now = Date.now() } = {}) {
  const url = new URL(spec.url);
  const headers = { accept: "application/json" };
  let credentialMode = "none";
  if (spec.provider === "coingecko" && env.COINGECKO_DEMO_API_KEY) {
    headers["x-cg-demo-api-key"] = env.COINGECKO_DEMO_API_KEY;
    credentialMode = "demo-key";
  }
  if (spec.provider === "fred" && env.FRED_API_KEY) {
    url.searchParams.set("api_key", env.FRED_API_KEY);
    credentialMode = "free-key";
  }
  const body = spec.body ? JSON.parse(JSON.stringify(spec.body).replaceAll('"$sevenDaysAgo"', String(now - 7 * 86400000))) : undefined;
  const result = { id: spec.id, provider: spec.provider, url: spec.url, method: body ? "POST" : "GET", ...(body ? { body } : {}), credentialMode, requestedAt: new Date().toISOString() };
  const start = performance.now();
  try {
    const response = await fetchImpl(url, { method: result.method, headers: body ? { ...headers, "content-type": "application/json" } : headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25000), redirect: "error" });
    result.httpStatus = response.status;
    result.responseHeaders = Object.fromEntries([...response.headers].filter(([key]) => /^(date|retry-after|x-ratelimit-[\w-]+|ratelimit-[\w-]+|content-type|last-modified|etag)$/.test(key)));
    const raw = await response.text();
    result.bytes = Buffer.byteLength(raw);
    result.sha256 = createHash("sha256").update(raw).digest("hex");
    if (!response.ok) {
      result.outcome = response.status === 429 ? "rate-limited" : [401, 403].includes(response.status) ? "access-denied" : "http-error";
    } else {
      try {
        const payload = spec.format === "csv" || spec.format === "text" ? raw : JSON.parse(raw);
        result.summary = summarize(payload, spec.summary);
        if (payload?.next_page_token || payload?.next_page_url) result.paginationRemaining = true;
        result.outcome = "sample-received";
      } catch {
        // Do not persist response bodies/errors: providers can echo credentials in them.
        result.outcome = "invalid-payload";
      }
    }
  } catch (error) {
    result.outcome = "network-error";
    const code = error?.cause?.code ?? error?.name;
    result.errorCode = /^[A-Z_0-9]+$/.test(code) ? code : "REQUEST_FAILED";
  }
  result.completedAt = new Date().toISOString();
  result.durationMs = Math.round(performance.now() - start);
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  let output = resolve(".reports/capabilities.json");
  let only;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" && args[i + 1]) output = resolve(args[++i]);
    else if (args[i] === "--only" && args[i + 1]) only = new Set(args[++i].split(","));
    else throw new Error("Usage: node scripts/probe-capabilities.mjs [--output path] [--only id,id]");
  }
  const manifestText = await readFile(new URL("./capability-probes.json", import.meta.url), "utf8");
  const manifest = JSON.parse(manifestText);
  if (only && [...only].some(id => !manifest.probes.some(spec => spec.id === id))) throw new Error("Unknown probe ID");
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), manifestSha256: createHash("sha256").update(manifestText).digest("hex"), classification: "capability-samples-not-an-ingestion-archive", results: [] };
  const queue = manifest.probes.filter(spec => !only || only.has(spec.id));
  const lastRequest = new Map();
  const throttled = new Set();
  await mkdir(dirname(output), { recursive: true });
  for (const spec of queue) {
    let result;
    if (throttled.has(spec.provider)) result = { id: spec.id, provider: spec.provider, url: spec.url, outcome: "skipped-after-rate-limit" };
    else {
      await delay(Math.max(0, (lastRequest.get(spec.provider) ?? 0) + manifest.providerSpacingMs[spec.provider] - Date.now()));
      lastRequest.set(spec.provider, Date.now());
      result = await probe(spec);
      if (result.outcome === "rate-limited") throttled.add(spec.provider);
    }
    report.results.push(result);
    // Probe every discovered namespace; never turn a failed catalog into assumed coverage.
    if (spec.summary.kind === "namespaces" && result.outcome === "sample-received") {
      for (const namespace of result.summary.namespaces.filter(row => row.name)) queue.push({ id: `hl-contexts-${namespace.name}`, provider: "hyperliquid", url: spec.url, body: { type: "metaAndAssetCtxs", dex: namespace.name }, summary: { kind: "contexts" } });
    }
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${result.id}: ${result.outcome}${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ""}`);
  }
  report.completedAt = new Date().toISOString();
  report.attemptedRequests = report.results.filter(result => result.requestedAt).length;
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Saved ${report.results.length} results to ${output}`);
  // A valid negative capability result is useful evidence. Transport/schema failures need investigation.
  if (report.results.some(result => ["network-error", "invalid-payload", "rate-limited", "skipped-after-rate-limit"].includes(result.outcome))) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
