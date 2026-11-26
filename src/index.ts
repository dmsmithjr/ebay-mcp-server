import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import "dotenv/config";

const clientId = process.env.EBAY_CLIENT_ID;
const clientSecret = process.env.EBAY_CLIENT_SECRET;
const refreshToken = process.env.EBAY_REFRESH_TOKEN;
const isSandbox = process.env.EBAY_ENV === "sandbox";

if (!clientId || !clientSecret) {
  throw new Error("Missing EBAY_CLIENT_ID or EBAY_CLIENT_SECRET in environment.");
}

const baseUrl = isSandbox ? "https://api.sandbox.ebay.com" : "https://api.ebay.com";
const tradingUrl = isSandbox
  ? "https://api.sandbox.ebay.com/ws/api.dll"
  : "https://api.ebay.com/ws/api.dll";

let cachedAppToken: { value: string; expiresAt: number } | null = null;
let cachedUserToken: { value: string; expiresAt: number } | null = null;

async function getAppToken(): Promise<string> {
  const now = Date.now();
  if (cachedAppToken && now < cachedAppToken.expiresAt - 30_000) {
    return cachedAppToken.value;
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(`${baseUrl}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`eBay app token request failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedAppToken = {
    value: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };
  return cachedAppToken.value;
}

async function getUserToken(): Promise<string> {
  if (!refreshToken) {
    throw new Error("Missing EBAY_REFRESH_TOKEN in environment. Add it to mcp.json and .env.");
  }

  const now = Date.now();
  if (cachedUserToken && now < cachedUserToken.expiresAt - 30_000) {
    return cachedUserToken.value;
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(`${baseUrl}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`eBay user token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedUserToken = {
    value: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };
  return cachedUserToken.value;
}

async function searchBrowseItems(q: string, limit: number) {
  const token = await getAppToken();
  const url = new URL(`${baseUrl}/buy/browse/v1/item_summary/search`);
  url.searchParams.set("q", q);
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`eBay search error (${res.status}): ${text}`);
  }

  const payload = (await res.json()) as {
    itemSummaries?: Array<{
      itemId?: string;
      title?: string;
      price?: { value?: string; currency?: string };
      condition?: string;
      itemWebUrl?: string;
    }>;
  };

  return (payload.itemSummaries ?? []).map((item) => ({
    itemId: item.itemId,
    title: item.title,
    price: item.price ? `${item.price.value} ${item.price.currency}` : null,
    numericPrice: item.price?.value ? Number(item.price.value) : null,
    condition: item.condition ?? null,
    url: item.itemWebUrl ?? null,
  }));
}

function extractXmlTag(block: string, tag: string): string | null {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? match[1].trim() : null;
}

const server = new McpServer({
  name: "ebay-mcp-server",
  version: "0.2.0",
});

// 1. Public Marketplace Search
server.tool(
  "search_ebay_items",
  "Search active eBay listings via Browse API for comping and deal sourcing",
  {
    q: z.string().min(1).describe("Search keywords"),
    limit: z.number().int().min(1).max(50).default(10).describe("Number of items to return"),
  },
  async ({ q, limit }) => {
    try {
      const items = await searchBrowseItems(q, limit);
      return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: String(err) }], isError: true };
    }
  }
);

// 2. Fetch Seller's Active Listings (Trading API GetMyeBaySelling)
server.tool(
  "get_my_active_listings",
  "Fetch active listings, prices, watch counts, and summary from your own eBay seller store",
  {
    page: z.number().int().min(1).default(1).describe("Page number"),
    perPage: z.number().int().min(1).max(100).default(25).describe("Items per page"),
  },
  async ({ page, perPage }) => {
    try {
      const userToken = await getUserToken();
      const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <ActiveList>
    <Include>true</Include>
    <Pagination>
      <EntriesPerPage>${perPage}</EntriesPerPage>
      <PageNumber>${page}</PageNumber>
    </Pagination>
  </ActiveList>
  <SellingSummary>
    <Include>true</Include>
  </SellingSummary>
</GetMyeBaySellingRequest>`;

      const res = await fetch(tradingUrl, {
        method: "POST",
        headers: {
          "Content-Type": "text/xml",
          "X-EBAY-API-CALL-NAME": "GetMyeBaySelling",
          "X-EBAY-API-SITEID": "0",
          "X-EBAY-API-COMPATIBILITY-LEVEL": "1355",
          "X-EBAY-API-IAF-TOKEN": userToken,
        },
        body: xmlBody,
      });

      const xmlText = await res.text();
      const ack = extractXmlTag(xmlText, "Ack");
      if (!res.ok || ack === "Failure") {
        const shortMsg = extractXmlTag(xmlText, "ShortMessage") ?? xmlText.slice(0, 500);
        return {
          content: [{ type: "text", text: `GetMyeBaySelling failed: ${shortMsg}` }],
          isError: true,
        };
      }

      const itemBlocks = xmlText.match(/<Item>[\s\S]*?<\/Item>/gi) ?? [];
      const items = itemBlocks.map((block) => ({
        itemId: extractXmlTag(block, "ItemID"),
        title: extractXmlTag(block, "Title"),
        currentPrice: extractXmlTag(block, "CurrentPrice"),
        quantityAvailable: extractXmlTag(block, "QuantityAvailable"),
        watchCount: extractXmlTag(block, "WatchCount"),
        hitCount: extractXmlTag(block, "HitCount"),
        listingType: extractXmlTag(block, "ListingType"),
        viewItemURL: extractXmlTag(block, "ViewItemURL"),
      }));

      const totalActive = extractXmlTag(xmlText, "TotalNumberOfEntries");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ totalActiveEntries: totalActive, page, items }, null, 2),
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: String(err) }], isError: true };
    }
  }
);

// 3. Store Traffic & Impressions Report (Sell Analytics API)
server.tool(
  "get_store_traffic",
  "Pull impressions, click-through rate, and views for your eBay listings over the last 30 days",
  {
    days: z.number().int().min(1).max(90).default(30).describe("Lookback window in days"),
  },
  async ({ days }) => {
    try {
      const userToken = await getUserToken();
      const end = new Date();
      const start = new Date(end.getTime() - days * 86_400_000);
      const fmt = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");

      const url = new URL(`${baseUrl}/sell/analytics/v1/traffic_report`);
      url.searchParams.set("dimension", "LISTING");
      url.searchParams.set("filter", `marketplace_ids:{EBAY_US},date_range:[${fmt(start)}..${fmt(end)}]`);
      url.searchParams.set(
        "metric",
        "LISTING_IMPRESSION_TOTAL,CLICK_THROUGH_RATE,LISTING_VIEWS_TOTAL,SALES_CONVERSION_RATE"
      );

      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${userToken}`,
          Accept: "application/json",
        },
      });

      const text = await res.text();
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `Traffic report failed (${res.status}): ${text}` }],
          isError: true,
        };
      }

      return { content: [{ type: "text", text }] };
    } catch (err) {
      return { content: [{ type: "text", text: String(err) }], isError: true };
    }
  }
);

// 4. Compare One of Your Listings Against Active Market Comps
server.tool(
  "audit_my_listing",
  "Compare one of your listing titles and prices against active eBay market comps",
  {
    myTitle: z.string().min(1).describe("Your current listing title"),
    myPrice: z.number().positive().describe("Your current listing price in USD"),
    searchKeywords: z.string().min(1).describe("Clean keywords to search competing listings"),
  },
  async ({ myTitle, myPrice, searchKeywords }) => {
    try {
      const comps = await searchBrowseItems(searchKeywords, 15);
      const prices = comps
        .map((c) => c.numericPrice)
        .filter((p): p is number => typeof p === "number" && !Number.isNaN(p))
        .sort((a, b) => a - b);

      const avg = prices.length ? prices.reduce((sum, p) => sum + p, 0) / prices.length : null;
      const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                yourListing: {
                  title: myTitle,
                  titleLength: myTitle.length,
                  charsRemainingOutOf80: 80 - myTitle.length,
                  price: myPrice,
                },
                marketCompsSummary: {
                  sampleCount: prices.length,
                  lowestPrice: prices[0] ?? null,
                  medianPrice: median,
                  averagePrice: avg ? Number(avg.toFixed(2)) : null,
                  highestPrice: prices[prices.length - 1] ?? null,
                },
                topComps: comps.slice(0, 8),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return { content: [{ type: "text", text: String(err) }], isError: true };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal MCP server error:", err);
  process.exit(1);
});