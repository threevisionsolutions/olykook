# Product Discovery: store connectors

This is the backend for a product discovery and comparison app. It searches several stores at once,
reads any product link a user pastes, and finds products from a photo. Every store's data is converted
to one `Product` shape, so the AI chat layer can compare items without caring where they came from.

## What's connected

| Store | How | Cost | Search | Pasted links | Photo search |
|---|---|---|---|---|---|
| **eBay** | Official Browse API | Free | ✅ | ✅ | ✅ native visual search |
| **Amazon** | Official Creators API (replaced PA-API 5) | Free, but needs Associates approval and sales | ✅ | ✅ | via Claude |
| ↳ until approved | SerpApi's Amazon search | Free quota, then paid | ✅ | page reader | via Claude |
| **AliExpress** | Official Affiliate API | Free | ✅ | ✅ | via Claude |
| **Walmart** | Official Affiliate API (falls back to SerpApi) | Free | ✅ | ✅ | via Claude |
| **Best Buy** | Official Products API | Free | ✅ | ✅ | via Claude |
| **Etsy** | Official Open API v3 | Free | ✅ | ✅ | via Claude |
| **Google Shopping** | SerpApi | Free quota, then paid | ✅ (covers Target, Home Depot, Newegg and many more) | n/a | ✅ Google Lens (needs a public image URL) |
| **Any other store** (Alibaba.com, Shopify stores, etc.) | Page reader | Free | n/a | ✅ | n/a |

**Alibaba.com** has no public product-search API. Its consumer marketplace, AliExpress, is covered through
the official API, and pasted alibaba.com links are read from the page.

### Why official APIs instead of scraping

Official APIs give accurate prices and stock, aren't blocked, earn affiliate commission, and don't break
when a store redesigns its pages. Scraping store **search** pages (Amazon in particular) from a server gets
blocked by bot checks quickly and breaks the stores' terms. Scraping is used only where it's reliable and
low-risk: reading **one page that a user pasted**, which works on most stores through the product data
they publish for Google. When a store shows a bot check, the API says so plainly.

## Getting started

```bash
npm install
cp .env.example .env      # add the keys you have; everything is optional
npm run dev               # http://localhost:3000 opens a test page
npm test                  # 43 tests, no keys or network needed
npm run search -- "wireless earbuds"                     # check your keys from the terminal
npm run search -- https://www.amazon.com/dp/B0BX2L8PBT   # read pasted links
```

### Suggested signup order

1. **eBay**, **Best Buy**, **Etsy**: free, instant keys. Good coverage on day one.
2. **SerpApi**: one key adds Google Shopping plus Amazon and Walmart results right away.
3. **AliExpress** and **Walmart** affiliate programs: free, approval takes a few days.
4. **Amazon Associates**: apply early. Creators API access opens only after your site makes qualifying sales.
5. **Anthropic**: makes photo search work on every store.

## API

| Endpoint | What it does |
|---|---|
| `GET /api/search?q=…&max_price=&min_price=&sort=relevance\|price_asc\|price_desc\|rating&sources=amazon,ebay&limit=` | Searches all connected stores in parallel |
| `POST /api/resolve` `{"urls": [...]}` | Reads up to 10 pasted product links |
| `POST /api/search/image` (multipart `image`, optional `hint`, `image_url`) | Finds products from a photo |
| `GET /api/providers` | Which stores are connected and how to set up the rest |

Search responses include `providers`, a per-store status list (`ok` / `error` / `skipped`), so one broken
store never fails a search. They also include `sameProductGroups`: the same item (matched by barcode)
sold by several stores, cheapest first. That's the core data for price comparison.

## Layout

```
src/
  types.ts              Product shape shared by everything
  providers/            One file per store (search, link lookup, image search)
  scrape/               Safe page fetching + product data extraction for pasted links
  services/             Multi-store search, link resolution, photo search
  ai/describeImage.ts   Claude turns a photo into a search query
  server.ts             HTTP API
public/index.html       Test page
```

To add a store, write a `Provider` in `src/providers/` and add it to `src/providers/index.ts`.

## Next steps

- **Chat layer:** give Claude the three endpoints as tools (search, read links, photo search) so it can
  compare products and recommend alternatives in conversation.
- **Shared cache:** results are cached in memory for 10 minutes. Use Redis once you run more than one server.
- **Rate limits:** add per-user limits before going public. SerpApi and Anthropic calls cost money.
