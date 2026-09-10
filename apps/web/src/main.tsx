import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import { api,useData,Status,type Metadata } from "./api";
import { DataHealth } from "./pages/DataHealth";
import { Research } from "./pages/Research";
import { ThesisNotes } from "./components/ThesisNotes";
import { SavedScreens,type Selection } from "./components/SavedScreens";
import { WorkspaceAccess } from "./components/WorkspaceAccess";
import { BtcCycles } from "./pages/BtcCycles";
import { MarketOverview } from "./pages/MarketOverview";
import { PerpDiscovery } from "./pages/PerpDiscovery";
import { AltcoinDiscovery } from "./pages/AltcoinDiscovery";
import { BacktestLab } from "./pages/BacktestLab";

type Asset = {
  id: string;
  symbol: string;
  name: string;
  rank: number | null;
  priceUsd: number | null;
  marketCapUsd: number | null;
  fullyDilutedValuationUsd: number | null;
  volume24hUsd: number | null;
  circulatingSupply: number | null;
  totalSupply: number | null;
  maxSupply: number | null;
  change24h: number | null;
  change7d: number | null;
  change30d: number | null;
  observedAt: string | null;
};
type DailyPrice = {
  observedAt: string;
  close: number | null;
};
type Fundamental = {
  code: "tvl_usd" | "fees_24h_usd" | "revenue_24h_usd";
  label: string;
  value: number | null;
  unit: "USD";
  scope: "chain" | "protocol" | "unavailable";
  coverage: string;
  available: boolean;
  stale: boolean;
  observedAt: string | null;
  acquiredAt: string | null;
};
type Fundamentals = {
  category: "L1" | "L2" | "DEX" | "lending" | "stablecoin" | "exchange token" | "unknown";
  fundamentals: Fundamental[];
  tokenomics: {
    circulatingPercent: number | null;
    nonCirculatingSupply: number | null;
    unlocks: { events: []; status: "unavailable"; note: string };
    emissions: {
      status: "stored" | "stale" | "unavailable";
      observedAt: string | null;
      source: string;
      note: string;
      metrics: { label: string; value: string }[];
    };
  };
  observedAt: string | null;
  stale: boolean;
};
type TokenomicsEvent = {
  id: string;
  type: "unlock" | "emission" | "burn" | "buyback";
  amount: number;
  unit: string;
  effectiveAt: string;
  publishedAt: string;
  sourceId: string;
  coverage: string;
  verification: "verified" | "reported";
};
type AssetDetail = {
  asset: Asset;
  priceHistory: { points: DailyPrice[]; metadata: Metadata & { missingIntervals: number; classification: "historical-reconstruction" } };
  returns: {
    day: number | null;
    week: number | null;
    month: number | null;
    quarter: number | null;
  };
  indicators: {
    sma7: number | null;
    sma30: number | null;
    rsi14: number | null;
    macd: number | null;
  };
  fundamentals: Fundamentals;
  tokenomicsEvents: TokenomicsEvent[];
};
type Page = "overview" | "btc" | "perp" | "altcoin" | "backtest" | "assets" | "watchlist" | "research" | "data-health";
const pages: { id: Page; label: string }[] = [
  { id: "overview", label: "Market Overview" },
  { id: "btc", label: "BTC Cycles" },
  { id: "perp", label: "Perp Discovery" },
  { id: "altcoin", label: "Altcoin Discovery" },
  { id: "backtest", label: "Backtest Lab" },
  { id: "assets", label: "Assets" },
  { id: "watchlist", label: "Watchlist" },
  { id:"research",label:"Research" },
  { id:"data-health",label:"Data Health" },
];
const profileAssets = [
  { id: "bitcoin", label: "BTC" },
  { id: "ethereum", label: "ETH" },
  { id: "solana", label: "SOL" },
  { id: "hyperliquid", label: "HYPE" },
];
const usd = (value: number | null) => value === null ? "—" :
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: value >= 1e9 ? "compact" : "standard",
    maximumFractionDigits: 2,
  }).format(value);
const pct = (value: number | null) => value === null ? "—" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
function Loading() {
  return <div className="loading">Loading market data…</div>;
}
function Failure({ retry }: { retry: () => void }) {
  return (
    <div className="failure">
      Unable to load this view. <button onClick={retry}>Try again</button>
    </div>
  );
}
function AssetTable({
  assets,
  action,
  onSelect,
}: {
  assets: Asset[];
  action?: (asset: Asset) => React.ReactNode;
  onSelect?: (asset: Asset) => void;
}) {
  return (
    <div className="table">
      <div className="row head">
        <span># Asset</span>
        <span>Price</span>
        <span>24h</span>
        <span>Market cap</span>
        <span>24h volume</span>
        {action && <span />}
      </div>
      {assets.map((a) => (
        <div className="row" key={a.id}>
          <span>
            <i>{a.rank}</i>{" "}
            {onSelect ? (
              <button className="asset-link" onClick={() => onSelect(a)}>
                <b>{a.symbol}</b> <em>{a.name}</em>
              </button>
            ) : (
              <>
                <b>{a.symbol}</b> <em>{a.name}</em>
              </>
            )}
          </span>
          <span>{usd(a.priceUsd)}</span>
          <span className={a.change24h === null ? "" : a.change24h < 0 ? "down" : "up"}>
            {pct(a.change24h)}
          </span>
          <span>{usd(a.marketCapUsd)}</span>
          <span>{usd(a.volume24hUsd)}</span>
          {action && <span className="action">{action(a)}</span>}
        </div>
      ))}
    </div>
  );
}
function Metric({ t, v, detail }: { t: string; v: string; detail?: string }) {
  return (
    <article>
      <span>{t}</span>
      <strong>{v}</strong>
      {detail && <small>{detail}</small>}
    </article>
  );
}
function Assets({ select }: { select: (id: string) => void }) {
  const { result, loading, error, reload } = useData<Asset[]>("/assets");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"rank" | "cap" | "change">("rank");
  const [minCap,setMinCap]=useState<number|null>(null),[maxCap,setMaxCap]=useState<number|null>(null);
  const selection:Selection={query,sort,minCap,maxCap};
  const apply=(value:Selection)=>{setQuery(value.query);setSort(value.sort);setMinCap(value.minCap);setMaxCap(value.maxCap);};
  const assets = useMemo(
    () =>
      [...(result?.data ?? [])]
        .filter((a) =>
          `${a.symbol} ${a.name}`.toLowerCase().includes(query.toLowerCase()),
        )
        .filter(asset=>(minCap===null||(asset.marketCapUsd!==null&&asset.marketCapUsd>=minCap))&&(maxCap===null||(asset.marketCapUsd!==null&&asset.marketCapUsd<=maxCap)))
        .sort((a, b) =>
          sort === "change"
            ? (b.change24h ?? -Infinity) - (a.change24h ?? -Infinity)
            : sort === "cap"
              ? (b.marketCapUsd ?? -Infinity) - (a.marketCapUsd ?? -Infinity)
              : (a.rank ?? Infinity) - (b.rank ?? Infinity),
        ),
    [result, query, sort,minCap,maxCap],
  );
  if (loading) return <Loading />;
  if (error || !result) return <Failure retry={reload} />;
  return (
    <section className="panel">
      <div className="panelhead toolbar">
        <div>
          <h2>Market assets</h2>
          <span>{result.metadata.coverage}</span>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search assets"
        />
        <div className="sort">
          <span>Sort</span>
          {(["rank", "cap", "change"] as const).map((v) => (
            <button
              className={sort === v ? "active" : ""}
              onClick={() => setSort(v)}
              key={v}
            >
              {v === "cap" ? "Market cap" : v}
            </button>
          ))}
        </div>
      </div>
      <SavedScreens selection={selection} apply={apply}/>
      <div className="cap-filters"><label>Min market cap (USD)<input type="number" min="0" value={minCap??''} onChange={e=>setMinCap(e.target.value===''?null:Number(e.target.value))}/></label>
      <label>Max market cap (USD)<input type="number" min="0" value={maxCap??''} onChange={e=>setMaxCap(e.target.value===''?null:Number(e.target.value))}/></label></div>
      {assets.length ? (
        <AssetTable assets={assets} onSelect={(a) => select(a.id)} />
      ) : (
        <div className="empty">No assets match “{query}”.</div>
      )}
      <Status metadata={result.metadata} />
    </section>
  );
}
function Watchlist() {
  const watched = useData<Asset[]>("/watchlist"),
    assets = useData<Asset[]>("/assets");
  const [busy, setBusy] = useState<string>();
  const mutate = async (a: Asset, exists: boolean) => {
    setBusy(a.id);
    try {
      await api(`/watchlist/${a.id}`, { method: exists ? "DELETE" : "PUT" });
      watched.reload();
    } finally {
      setBusy(undefined);
    }
  };
  if (watched.loading || assets.loading) return <Loading />;
  if (watched.error || assets.error || !watched.result || !assets.result)
    return (
      <Failure
        retry={() => {
          watched.reload();
          assets.reload();
        }}
      />
    );
  const ids = new Set(watched.result.data.map((a) => a.id));
  return (
    <>
      <section className="panel">
        <div className="panelhead">
          <div>
            <h2>Your watchlist</h2>
            <span>Assets saved in your personal PostgreSQL workspace</span>
          </div>
          <span>{watched.result.data.length} saved</span>
        </div>
        {watched.result.data.length ? (
          <AssetTable
            assets={watched.result.data}
            action={(a) => (
              <button disabled={busy === a.id} onClick={() => mutate(a, true)}>
                Remove
              </button>
            )}
          />
        ) : (
          <div className="empty">
            No saved assets yet. Add some from the market list below.
          </div>
        )}
        <Status metadata={watched.result.metadata} />
      </section>
      <section className="panel add-assets">
        <div className="panelhead">
          <div>
            <h2>Add to watchlist</h2>
            <span>Top market assets</span>
          </div>
        </div>
        <AssetTable
          assets={assets.result.data}
          action={(a) => (
            <button
              disabled={ids.has(a.id) || busy === a.id}
              onClick={() => mutate(a, ids.has(a.id))}
            >
              {ids.has(a.id) ? "Saved" : "Add"}
            </button>
          )}
        />
      </section>
    </>
  );
}
function number(value: number | null, digits = 2) {
  return value === null
    ? "—"
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(
        value,
      );
}
function Sparkline({ prices }: { prices: DailyPrice[] }) {
  const values = prices.flatMap(point => point.close === null ? [] : [point.close]);
  if (!values.length) return <div className="empty">No daily prices in this range.</div>;
  const low = Math.min(...values),
    high = Math.max(...values),
    range = high - low || 1;
  const firstTime = Date.parse(prices[0].observedAt);
  const span = Date.parse(prices.at(-1)!.observedAt) - firstTime || 1;
  const segments: string[][] = [];
  let previousTime = -Infinity;
  for (const point of prices) {
    const time = Date.parse(point.observedAt);
    if (point.close === null) { previousTime = -Infinity; continue; }
    if (time - previousTime !== 86_400_000) segments.push([]);
    segments.at(-1)!.push(`${(time - firstTime) / span * 100},${100 - ((point.close - low) / range) * 100}`);
    previousTime = time;
  }
  return (
    <div className="chart">
      <div className="chart-top">
        <span>DAILY PRICE · USD</span>
        <span>{usd(values.at(-1) ?? 0)}</span>
      </div>
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-label="Daily USD price chart; gaps are not filled"
      >
        {segments.map((points, index) => <polyline key={index} points={points.join(" ")} />)}
      </svg>
      <div className="chart-axis">
        <span>{usd(low)}</span>
        <span>{usd(high)}</span>
      </div>
    </div>
  );
}
function FundamentalsTab({ data }: { data: Fundamentals }) {
  const coverage = data.fundamentals[0]?.coverage ?? "No coverage available.";
  return (
    <section className="detail-grid tab-grid">
      <article className="panel fundamentals">
        <div>
          <h2>
            Fundamentals{" "}
            <small>
              {data.category} · {data.fundamentals[0]?.scope ?? "unavailable"}{" "}
              scope
            </small>
          </h2>
          {data.fundamentals.map((metric) => (
            <div key={metric.code}>
              <span>{metric.label}<small> · {metric.available ? metric.stale ? "Stale" : "Stored" : "Unavailable"}</small></span>
              <b>{metric.value === null ? "—" : usd(metric.value)}</b>
            </div>
          ))}
          <p>{coverage}</p>
          {data.fundamentals.map(metric => <p key={metric.code}>
            {metric.label}: {metric.coverage}. Observed {metric.observedAt ? new Date(metric.observedAt).toLocaleString() : "time unknown"};
            acquired {metric.acquiredAt ? new Date(metric.acquiredAt).toLocaleString() : "unavailable"}.
          </p>)}
        </div>
        <Status
          metadata={{
            source: "DefiLlama",
            observedAt: data.observedAt,
            coverage,
            stale: data.stale,
          }}
        />
      </article>
      <article className="panel metric-notes">
        <h2>How to read this</h2>
        <p>
          Values are only shown when the source covers this asset’s category.
          Chain metrics describe protocols deployed on a chain; protocol metrics describe the
          protocol, not necessarily its token.
        </p>
      </article>
    </section>
  );
}
function TokenomicsTab({
  asset,
  data,
  events,
}: {
  asset: Asset;
  data: Fundamentals;
  events: TokenomicsEvent[];
}) {
  return (
    <section className="detail-grid tab-grid">
      <article className="panel tokenomics">
        <div>
          <h2>Supply & coverage</h2>
          <div>
            <span>Circulating supply</span>
            <b>{number(asset.circulatingSupply, 0)}</b>
          </div>
          <div>
            <span>Total supply</span>
            <b>{number(asset.totalSupply, 0)}</b>
          </div>
          <div>
            <span>Max supply</span>
            <b>{number(asset.maxSupply, 0)}</b>
          </div>
          <div>
            <span>Circulating / max</span>
            <b>
              {data.tokenomics.circulatingPercent === null
                ? "—"
                : `${number(data.tokenomics.circulatingPercent)}%`}
            </b>
          </div>
          <div>
            <span>Not circulating</span>
            <b>{number(data.tokenomics.nonCirculatingSupply, 0)}</b>
          </div>
        </div>
      </article>
      <article className="panel metric-notes">
        <h2>Emissions & unlocks</h2>
        {events.length ? (
          <div className="token-events">
            {events.map((event) => (
              <div key={event.id}>
                <span>
                  {event.type} ·{" "}
                  {new Date(event.effectiveAt).toLocaleDateString()}
                </span>
                <b>
                  {number(event.amount, 0)} {event.unit}
                </b>
                <small>
                  {event.verification} · {event.sourceId}
                </small>
              </div>
            ))}
          </div>
        ) : (
          <>
            <p>{data.tokenomics.emissions.note}</p>
            {data.tokenomics.emissions.metrics.map(metric => <p key={metric.label}><b>{metric.label}: </b>{metric.value}</p>)}
            <p>Source: {data.tokenomics.emissions.source} · {data.tokenomics.emissions.status}</p>
            <p>Observed: {data.tokenomics.emissions.observedAt ? new Date(data.tokenomics.emissions.observedAt).toLocaleString() : "Unavailable"}</p>
            <p>{data.tokenomics.unlocks.note}</p>
          </>
        )}
      </article>
    </section>
  );
}
function AssetProfile({
  assetId,
  back,
}: {
  assetId: string;
  back: () => void;
}) {
  const { result, loading, error, reload } = useData<AssetDetail>(
    `/assets/${assetId}`,
  );
  const [range,setRange]=useState("90D");
  useEffect(()=>{void api<{preferences:Record<string,{range:string}>}>("/workspace").then(r=>setRange(r.data.preferences["price-chart"]?.range??"90D")).catch(()=>{});},[]);
  const [tab, setTab] = useState<"overview" | "fundamentals" | "tokenomics" | "notes">(
    "overview",
  );
  if (loading) return <Loading />;
  if (error || !result) return <Failure retry={reload} />;
  const { asset, priceHistory, returns, indicators, fundamentals } = result.data;
  const chartStart = Date.parse(priceHistory.points.at(-1)?.observedAt ?? "") - (range==="30D"?29:range==="1Y"?364:range==="All"?10000:89) * 86_400_000;
  const chartPrices = priceHistory.points.filter(point => Date.parse(point.observedAt) >= chartStart);
  return (
    <>
      <button className="back" onClick={back}>
        ← All assets
      </button>
      <section className="asset-hero">
        <div>
          <label>ASSET PROFILE · HISTORICAL RECONSTRUCTION</label>
          <h1>
            {asset.name} <span>{asset.symbol}</span>
          </h1>
          <p>
            Rank #{asset.rank} ·{" "}
            {asset.circulatingSupply === null
              ? "Supply unavailable"
              : `${number(asset.circulatingSupply, 0)} circulating tokens`}
          </p>
        </div>
        <div>
          <strong>{usd(asset.priceUsd)}</strong>
          <span className={asset.change24h === null ? "" : asset.change24h < 0 ? "down" : "up"}>
            {pct(asset.change24h)} 24h
          </span>
        </div>
      </section>
      <nav className="asset-switcher" aria-label="Select an asset">
        {profileAssets.map((item) => (
          <button
            key={item.id}
            className={asset.id === item.id ? "active" : ""}
            onClick={() => (location.hash = `asset/${item.id}`)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <nav className="asset-tabs" aria-label="Asset profile sections">
        {(["overview", "fundamentals", "tokenomics", "notes"] as const).map((item) => (
          <button
            key={item}
            className={tab === item ? "active" : ""}
            onClick={() => setTab(item)}
          >
            {item}
          </button>
        ))}
      </nav>
      {tab === "overview" && (
        <>
          <section className="kpis profile-kpis">
            <Metric t="Market cap" v={usd(asset.marketCapUsd)} />
            <Metric
              t="FDV"
              v={
                asset.fullyDilutedValuationUsd === null
                  ? "—"
                  : usd(asset.fullyDilutedValuationUsd)
              }
            />
            <Metric t="24h volume" v={usd(asset.volume24hUsd)} />
            <Metric
              t="Circulating supply"
              v={number(asset.circulatingSupply, 0)}
            />
          </section>
          <section className="detail-grid">
            <article className="panel">
              {priceHistory.points.length ? (
                <>
                  <div className="chart-ranges" aria-label="Price chart range">{["30D","90D","1Y","All"].map(value=><button key={value} className={range===value?"active":""} onClick={()=>{setRange(value);void api("/research/preferences/price-chart",{method:"PUT",body:JSON.stringify({range:value})});}}>{value}</button>)}</div>
                  <Sparkline prices={chartPrices} />
                  <div className="ohlcv">
                    <span>{chartPrices[0]?.observedAt.slice(0, 10)} – {chartPrices.at(-1)?.observedAt.slice(0, 10)}</span>
                    <span>{priceHistory.metadata.missingIntervals} missing daily observations</span>
                  </div>
                </>
              ) : (
                <div className="empty">
                  {priceHistory.metadata.unavailable
                    ? "Daily price history is temporarily unavailable. Snapshot metrics remain available."
                    : "Daily price history has not been archived yet. Snapshot metrics remain available."}
                </div>
              )}
              <Status metadata={priceHistory.metadata} />
            </article>
            <article className="panel indicators">
              <h2>Returns & technicals</h2>
              <p>Completed daily prices as of {priceHistory.metadata.observedAt?.slice(0, 10) ?? "unavailable"}.</p>
              <div>
                <span>1D</span>
                <b className={(returns.day ?? 0) < 0 ? "down" : "up"}>
                  {returns.day === null ? "—" : pct(returns.day)}
                </b>
              </div>
              <div>
                <span>7D</span>
                <b className={(returns.week ?? 0) < 0 ? "down" : "up"}>
                  {returns.week === null ? "—" : pct(returns.week)}
                </b>
              </div>
              <div>
                <span>30D</span>
                <b className={(returns.month ?? 0) < 0 ? "down" : "up"}>
                  {returns.month === null ? "—" : pct(returns.month)}
                </b>
              </div>
              <div>
                <span>RSI 14</span>
                <b>{number(indicators.rsi14)}</b>
              </div>
              <div>
                <span>SMA 7 / 30</span>
                <b>
                  {number(indicators.sma7)} / {number(indicators.sma30)}
                </b>
              </div>
              <div>
                <span>MACD</span>
                <b>{number(indicators.macd, 4)}</b>
              </div>
            </article>
          </section>
          <section className="panel tokenomics">
            <div>
              <h2>Supply & coverage</h2>
              <div>
                <span>Total supply</span>
                <b>{number(asset.totalSupply, 0)}</b>
              </div>
              <div>
                <span>Max supply</span>
                <b>{number(asset.maxSupply, 0)}</b>
              </div>
              <div>
                <span>Data coverage</span>
                <b>{priceHistory.points.filter(point => point.close !== null).length} daily price observations</b>
              </div>
            </div>
            <Status metadata={result.metadata} />
          </section>
        </>
      )}
      {tab === "notes" && <ThesisNotes assetId={assetId} />}
      {tab === "fundamentals" && <FundamentalsTab data={fundamentals} />}
      {tab === "tokenomics" && (
        <TokenomicsTab
          asset={asset}
          data={fundamentals}
          events={result.data.tokenomicsEvents}
        />
      )}
    </>
  );
}
function AnalyticsCard({
  path,
  title,
  description,
}: {
  path: string;
  title: string;
  description: string;
}) {
  const { result, loading, error, reload } = useData<unknown[]>(path);
  return (
    <article className="analytics-card">
      <h2>{title}</h2>
      <p>{description}</p>
      {loading ? (
        <span>Loading…</span>
      ) : error || !result ? (
        <button onClick={reload}>Retry</button>
      ) : (
        <>
          <div className="unavailable">
            {result.metadata.unavailable
              ? "Data feed not connected"
              : "No observations available"}
          </div>
          <Status metadata={result.metadata} />
        </>
      )}
    </article>
  );
}
function App() {
  const getRoute = () => location.hash.slice(1) || "overview";
  const [route, setRoute] = useState(getRoute);
  useEffect(() => {
    const onHash = () => setRoute(getRoute());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const assetId = route.startsWith("asset/")
    ? decodeURIComponent(route.slice(6))
    : null;
  const page: Page = assetId ? "assets" : (route.split("?")[0] as Page);
  const navigate = (p: Page) => (location.hash = p);
  const select = (id: string) =>
    (location.hash = `asset/${encodeURIComponent(id)}`);
  return (
    <div className="shell">
      <aside>
        <a className="brand" href="#overview">
          ◆ CRYPTO//PANEL
        </a>
        <nav>
          {pages.map((p) => (
            <a
              href={`#${p.id}`}
              className={page === p.id ? "on" : ""}
              key={p.id}
            >
              {p.label}
            </a>
          ))}
        </nav>
        <small>
          DATA REFRESH
          <br />
          <strong>SCHEDULED ARCHIVE</strong>
          <br />
          USD · ENGLISH
        </small>
      </aside>
      <main>
        <header>
          <div>
            <label>MARKET TERMINAL</label>
            <h1>
              {assetId
                ? "Asset profile"
                : pages.find((p) => p.id === page)?.label}
            </h1>
          </div>
          <div className="live">
            ● MARKET DATA{" "}
            <button onClick={() => location.reload()}>Refresh</button>
          </div>
        </header>
        {assetId ? (
          <AssetProfile assetId={assetId} back={() => navigate("assets")} />
        ) : (
          <>
            {page === "overview" && <MarketOverview select={select} />}{" "}
            {page === "assets" && <Assets key={route} select={select} />}{" "}
            {page === "watchlist" && <Watchlist />}{" "}
            {page === "research" && <Research />}
            {page === "btc" && <BtcCycles />}
            {page === "perp" && <PerpDiscovery />}
            {page === "altcoin" && <AltcoinDiscovery />}
            {page === "backtest" && <BacktestLab />}
            {page === "data-health" && <DataHealth />}
          </>
        )}
        <footer>
          NOT INVESTMENT ADVICE · Market data includes its source, observation
          time, coverage and stale status.
        </footer>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<WorkspaceAccess><App /></WorkspaceAccess>);
