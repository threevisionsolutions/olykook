/** Trimmed-down copies of real product page markup. */

export const SHOPIFY_PAGE = `<!doctype html><html><head>
<title>Allbirds Tree Runner – Allbirds</title>
<link rel="canonical" href="/products/mens-tree-runners" />
<meta property="og:title" content="Men's Tree Runners" />
<meta property="og:image" content="https://cdn.shopify.com/og.jpg" />
<script type="application/ld+json">{
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "Organization", "name": "Allbirds" },
    { "@type": "ProductGroup", "name": "Men's Tree Runners", "description": "Breathable sneaker
made from eucalyptus fiber.",
      "brand": { "@type": "Brand", "name": "Allbirds" },
      "aggregateRating": { "@type": "AggregateRating", "ratingValue": "4.5", "reviewCount": "2310" },
      "hasVariant": [ { "@type": "Product", "sku": "TR-M-9", "gtin13": "0194568123456", "image": ["/img/tr-1.jpg", "/img/tr-2.jpg"],
        "offers": { "@type": "Offer", "price": "98.00", "priceCurrency": "USD", "availability": "https://schema.org/InStock" } } ]
    }
  ]
}</script></head><body></body></html>`;

export const AMAZON_PAGE = `<!doctype html><html><head><title>Amazon.com: Anker Power Bank</title></head><body>
<span id="productTitle">   Anker Power Bank, 10,000mAh Portable Charger   </span>
<a id="bylineInfo">Visit the Anker Store</a>
<div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">$21.99</span></span></div>
<span class="basisPrice"><span class="a-offscreen">$29.99</span></span>
<img id="landingImage" data-old-hires="https://m.media-amazon.com/images/I/big.jpg" src="https://m.media-amazon.com/images/I/small.jpg" />
<span id="acrPopover" title="4.6 out of 5 stars"></span>
<span id="acrCustomerReviewText">48,512 ratings</span>
<div id="availability"><span> In Stock </span></div>
<div id="feature-bullets"><ul><li><span class="a-list-item">Charges an iPhone 15 about 2 times</span></li><li><span class="a-list-item">USB-C in and out</span></li></ul></div>
<table id="productDetails_techSpec_section_1"><tr><th>Battery Capacity</th><td>10000 Milliamp Hours</td></tr></table>
</body></html>`;

export const OG_ONLY_PAGE = `<html><head>
<meta property="og:title" content="Vintage Desk Lamp" />
<meta property="og:image" content="https://shop.example/lamp.jpg" />
<meta property="product:price:amount" content="1.299,00" />
<meta property="product:price:currency" content="EUR" />
</head></html>`;

export const CAPTCHA_PAGE = `<html><head><title>Robot Check</title></head><body>
<form action="/errors/validateCaptcha"><input name="field-keywords"></form></body></html>`;

/** Patterns seen on live pages (Oct 2026), trimmed. */
export const AMAZON_LIVE_PAGE = `<html><head><title>Amazon.com: Apple AirPods Pro 2</title>
<link rel="canonical" href="https://www.amazon.com/clp/B0CHWRXH8B"/></head><body>
<span id="productTitle">Apple AirPods Pro (2nd Generation)</span>
<div id="corePriceDisplay_desktop_feature_div"><span class="a-price"><span class="a-offscreen"> </span></span></div>
<div id="apex_offerDisplay_desktop"><span class="a-price"><span class="a-offscreen">$263.86</span></span></div>
<div id="availability"><span>In Stock</span><script>P.when("A").execute(function(){ var x = {"isRobot":false}; });</script></div>
</body></html>`;

export const AMAZON_UNAVAILABLE_PAGE = `<html><body><span id="productTitle">Echo Dot (4th Gen)</span>
<div id="availability"><span>Currently unavailable.</span><span> We don't know when or if this item will be back in stock.</span></div>
</body></html>`;

export const AMAZON_CONTINUE_WALL = `<html><head><title dir="ltr">Amazon.com</title></head><body>
<!-- To discuss automated access to Amazon data please contact api-services-support@amazon.com. -->
<h4>Click the button below to continue shopping</h4></body></html>`;

export const ALIEXPRESS_CAPTCHA = `<script>var url = window.location.protocol + "//www.aliexpress.com//item/1.html/_____tmd_____/punish?x5secdata=abc";window._config_ = {"action":"captcha"};</script>`;

export const WALMART_BLOCKED = `<html><head><title>Robot or human?</title></head><body><div id="px-captcha"></div>${"<p>filler</p>".repeat(800)}</body></html>`;

export const CATEGORY_PAGE = `<html><head><title>Products - IKEA</title>
<meta property="og:type" content="product.group"/><meta property="og:title" content="Products"/></head><body></body></html>`;

export const SHOPIFY_META_ONLY_PAGE = `<html><head><meta property="og:type" content="product"/><meta property="og:title" content="Classic Percale Core Sheet Set"/>
<script>var meta = {"product":{"id":7296487424090,"vendor":"Brooklinen","variants":[{"id":111,"price":18900,"name":"King","public_title":"King","sku":"K-1"},{"id":222,"price":15900,"name":"Queen","public_title":"Queen","sku":"Q-1"}]},"page":{"pageType":"product"}};
Shopify.currency = {"active":"USD","rate":"1.0"};</script></head><body></body></html>`;
