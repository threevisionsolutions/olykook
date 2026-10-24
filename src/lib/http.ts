export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string,
    public url: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface FetchOptions extends RequestInit {
  timeoutMs?: number;
  /** Retries for 429 / 5xx / network errors. Default 2. */
  retries?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch with a timeout and retries on 429/5xx. Throws HttpError on non-2xx. */
export async function fetchWithRetry(url: string, opts: FetchOptions = {}): Promise<Response> {
  const { timeoutMs = 12_000, retries = 2, ...init } = opts;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return res;

      const body = await res.text().catch(() => "");
      const err = new HttpError(`HTTP ${res.status} from ${new URL(url).host}`, res.status, body.slice(0, 2000), url);
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === retries) throw err;
      lastError = err;

      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 500 * 2 ** attempt);
    } catch (err) {
      if (err instanceof HttpError) throw err;
      lastError = err;
      if (attempt === retries) break;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastError;
}

export async function fetchJson<T = any>(url: string, opts: FetchOptions = {}): Promise<T> {
  const res = await fetchWithRetry(url, {
    ...opts,
    headers: { Accept: "application/json", ...(opts.headers as Record<string, string>) },
  });
  return (await res.json()) as T;
}

/** Parse "$1,299.99", "1.299,99 €", "US $12.50" etc. into a number. */
export function parsePrice(input: unknown): number | undefined {
  if (typeof input === "number") return Number.isFinite(input) ? input : undefined;
  if (typeof input !== "string") return undefined;
  const m = input.replace(/\s/g, "").match(/\d[\d.,]*/);
  if (!m) return undefined;
  let s = m[0];
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma > lastDot) {
    // "1.299,99" or "12,50" → comma is the decimal separator if followed by 1–2 digits
    s = /,\d{1,2}$/.test(s) ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else {
    s = s.replace(/,/g, "");
  }
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}

const SYMBOLS: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR", "₩": "KRW" };

export function guessCurrency(input: unknown, fallback = "USD"): string {
  if (typeof input !== "string") return fallback;
  const code = input.match(/\b([A-Z]{3})\b/);
  if (code) return code[1];
  for (const [sym, cur] of Object.entries(SYMBOLS)) if (input.includes(sym)) return cur;
  return fallback;
}

export function toNumber(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number.parseFloat(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

export function compact<T extends object>(obj: T): T {
  for (const k of Object.keys(obj) as (keyof T)[]) {
    const v = obj[k];
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) delete obj[k];
  }
  return obj;
}
