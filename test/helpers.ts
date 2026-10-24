import { vi } from "vitest";

export interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

type Handler = (req: Recorded) => { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };

/** Replace global fetch with a router: first matching [pattern, handler] wins. Returns the request log. */
export function mockFetch(routes: [RegExp, Handler][]): Recorded[] {
  const log: Recorded[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init.headers as HeadersInit).forEach((v, k) => (headers[k] = v));
    const body = init.body === undefined ? undefined : String(init.body);
    const req = { url, method: init.method ?? "GET", headers, body };
    log.push(req);
    const route = routes.find(([re]) => re.test(url));
    if (!route) return new Response(`no mock for ${url}`, { status: 599 });
    const r = route[1](req);
    const payload = r.json !== undefined ? JSON.stringify(r.json) : (r.text ?? "");
    return new Response(payload, {
      status: r.status ?? 200,
      headers: { "content-type": r.json !== undefined ? "application/json" : "text/html", ...r.headers },
    });
  });
  return log;
}

export function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

export const ALL_KEYS = [
  "EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_CAMPAIGN_ID", "EBAY_ENV",
  "AMAZON_CREDENTIAL_ID", "AMAZON_CREDENTIAL_SECRET", "AMAZON_PARTNER_TAG", "AMAZON_CREDENTIAL_VERSION",
  "ALIEXPRESS_APP_KEY", "ALIEXPRESS_APP_SECRET", "ALIEXPRESS_TRACKING_ID",
  "WALMART_CONSUMER_ID", "WALMART_PRIVATE_KEY", "WALMART_PRIVATE_KEY_PATH", "WALMART_PUBLISHER_ID",
  "BESTBUY_API_KEY", "ETSY_API_KEY", "ETSY_SHARED_SECRET", "SERPAPI_API_KEY", "ANTHROPIC_API_KEY",
];

export function clearEnv() {
  setEnv(Object.fromEntries(ALL_KEYS.map((k) => [k, undefined])));
}
