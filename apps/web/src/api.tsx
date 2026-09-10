import { useEffect, useState } from "react";
export type Metadata = {
  source: string;
  observedAt: string | null;
  coverage: string;
  stale: boolean;
  unavailable?: boolean;
};
export type Api<T> = {data:T;metadata:Metadata};
export async function api<T>(path: string, options?: RequestInit): Promise<Api<T>> {
  const res = await fetch(`/api/v1${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...(sessionStorage.getItem("workspace-token") ? {authorization:`Bearer ${sessionStorage.getItem("workspace-token")}`} : {}), ...options?.headers },
  });
  if (!res.ok && res.status !== 204)
    throw new Error((await res.json().catch(()=>({}))).error ?? "Request failed.");
  return res.status === 204 ? ({} as Api<T>) : res.json();
}
export function useData<T>(path: string) {
  const [state, setState] = useState<{
    result?: Api<T>;
    error?: string;
    loading: boolean;
  }>({ loading: true });
  const reload = () => {
    setState({ loading: true });
    api<T>(path)
      .then((result) => setState({ result, loading: false }))
      .catch(() =>
        setState({ error: "Unable to load this market data.", loading: false }),
      );
  };
  useEffect(reload, [path]);
  return { ...state, reload };
}
export function Status({ metadata }: { metadata?: Metadata }) {
  return metadata ? (
    <div className={`status ${metadata.stale ? "stale" : ""}`}>
      <span>{metadata.stale ? "STALE / UNAVAILABLE" : metadata.source}</span>
      <span>{metadata.coverage}</span>
      <span>
        {metadata.observedAt
          ? `UPDATED ${new Date(metadata.observedAt).toLocaleTimeString()}`
          : "UPDATED Unavailable"}
      </span>
    </div>
  ) : null;
}
