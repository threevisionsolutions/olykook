/**
 * Quick check from the terminal that your keys work:
 *   npm run search -- "wireless earbuds"
 *   npm run search -- https://www.amazon.com/dp/B0BX2L8PBT https://www.ebay.com/itm/123456789012
 */
import { resolveUrls } from "../src/services/resolveUrl.js";
import { searchAll } from "../src/services/search.js";

const args = process.argv.slice(2);
if (!args.length) {
  console.log('Usage: npm run search -- "search words"   or   npm run search -- <link> [link…]');
  process.exit(1);
}

const money = (m?: { amount: number; currency: string }) => (m ? `${m.currency} ${m.amount.toFixed(2)}` : "no price");

if (args.every((a) => /^https?:\/\/|^www\./i.test(a))) {
  if (args.length > 10) console.log(`Note: only the first 10 links are read at a time (you gave ${args.length}).\n`);
  for (const r of await resolveUrls(args)) {
    if (r.error) console.log(`✗ ${r.input}\n  ${r.error}`);
    else console.log(`✓ [${r.product!.store}, via ${r.product!.via}] ${r.product!.title}\n  ${money(r.product!.price)}  ${r.product!.url}`);
  }
} else {
  const result = await searchAll({ query: args.join(" "), limit: 5 });
  for (const r of result.providers) console.log(`${r.status === "ok" ? "✓" : r.status === "skipped" ? "·" : "✗"} ${r.provider.padEnd(16)} ${r.status === "ok" ? `${r.count} results, ${r.ms}ms` : r.error}`);
  console.log("");
  for (const p of result.products) console.log(`${p.store.padEnd(14)} ${money(p.price).padEnd(14)} ${p.title.slice(0, 80)}`);
}
