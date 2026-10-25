# Olykook: AI shopping assistant

Chat with an AI that finds and compares products from stores across the internet. Shoppers can describe
what they want, paste product links to compare, or upload a photo. The assistant (Claude) searches the
connected stores, reads the links, compares price, ratings and specs, and shows its top picks as cards.

Under the hood: one connector per store, all converted to a single `Product` shape, plus a page reader
for links from any other store.

## What's connected

**Works with zero setup:** search, photo search and pasted links all work out of the box, through Shopify's
Global Catalog (every Shopify store) and the page reader (any store's product page). The keys below add
the big marketplaces on top.

| Store | How | Cost | Search | Pasted links | Photo search |
|---|---|---|---|---|---|
| **Every Shopify store** (millions of brands: Allbirds, Skullcandy, Stanley, Brooklinen, Fleet Feet…) | Shopify Global Catalog | **Free, no key** (optional free key for guaranteed speed) | ✅ | ✅ | ✅ native visual search |
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

### About the Shopify Global Catalog

Shopify built it for AI shopping assistants: one search across all Shopify merchants, with prices,
ratings, stock, specs, sale prices and photo search. Without a key, requests share Shopify's anonymous
lane, which is fine for building and testing but has no guaranteed speed. Before launch, get the free key
(dev.shopify.com/dashboard → Catalogs → Get an API key) for 5 searches/second, and host your own
[agent profile](https://shopify.dev/docs/agents/get-started/profile) JSON at a public URL
(`SHOPIFY_AGENT_PROFILE_URL`). It only covers Shopify stores, so Amazon, Walmart, eBay and the like
still come from their own APIs.

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
npm run dev               # http://localhost:3000 = chat,  /playground = API test page
npm test                  # 71 tests, no keys or network needed
npm run search -- "wireless earbuds"                     # check your keys from the terminal
npm run search -- https://www.amazon.com/dp/B0BX2L8PBT   # read pasted links
```

### Suggested signup order

0. **Nothing.** Shopify stores and pasted links work immediately.
1. **eBay**, **Best Buy**, **Etsy**: free, instant keys. Good coverage on day one.
2. **SerpApi**: one key adds Google Shopping plus Amazon and Walmart results right away.
3. **AliExpress** and **Walmart** affiliate programs: free, approval takes a few days.
4. **Amazon Associates**: apply early. Creators API access opens only after your site makes qualifying sales.
5. **Anthropic** (required for the chat): https://console.anthropic.com → API key → `ANTHROPIC_API_KEY`.

## The chat

`http://localhost:3000` is the chat. It needs `ANTHROPIC_API_KEY`; everything else is optional.

How it works (`src/chat/`):
- **`agent.ts`**: sends the conversation to Claude (`claude-opus-5-5`), streams the reply, runs the tools
  Claude asks for, and loops until it answers (max 8 tool rounds per message). If the main model declines a
  request, Anthropic automatically retries on its recommended fallback model.
- **`tools.ts`**: the four tools Claude can use: `search_products`, `read_product_links`, `search_by_photo`,
  and `show_recommendations` (the highlighted "Top picks" cards). Tool inputs are validated before running,
  and Claude can only recommend products a tool actually returned.
- **`prompt.ts`**: the assistant's instructions (ground every claim in real results, weigh ratings by review
  count, keep replies short because the cards show the details).
- **`store.ts`**: conversations live in memory for 2 hours. Move them to Redis or a database before running
  more than one server.

Cost: each message is one or more Claude calls. The instructions and earlier messages are cached, so
follow-up messages in a chat cost less. The server logs token usage per call (`[chat] … cache_read=…`).

## API

| Endpoint | What it does |
|---|---|
| `POST /api/chat` `{conversation_id?, message, photos?: [{base64, mime_type}]}` | One chat turn, streamed as Server-Sent Events (`conversation`, `text`, `tool_start`, `products`, `recommendations`, `tool_end`, `done` / `error`) |
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
  chat/                 AI chat: agent loop, tools, instructions, conversation store
  types.ts              Product shape shared by everything
  providers/            One file per store (search, link lookup, image search)
  scrape/               Safe page fetching + product data extraction for pasted links
  services/             Multi-store search, link resolution, photo search
  ai/describeImage.ts   Claude turns a photo into a search query
  server.ts             HTTP API
public/chat.html        Chat interface
public/playground.html  API test page
```

To add a store, write a `Provider` in `src/providers/` and add it to `src/providers/index.ts`.

## Next steps

- **Accounts and saved chats:** chats live in server memory today and disappear on restart.
- **Shared cache:** results are cached in memory for 10 minutes. Use Redis once you run more than one server.
- **Rate limits:** add per-user limits before going public. SerpApi and Anthropic calls cost money.
