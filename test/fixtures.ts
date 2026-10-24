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
