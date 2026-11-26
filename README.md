# eBay Seller Intelligence MCP Server

A custom Model Context Protocol (MCP) server built in TypeScript that connects AI coding agents (such as Cursor and Claude Code) directly to eBay's REST and XML Seller APIs. It enables automated store audits, 30-day listing traffic diagnostics, and real-time market comping against active eBay listings.

## Features

- **Live Store Inventory Inspection:** Pulls active fixed-price and auction listings, current pricing, quantities, and watcher counts via the eBay Trading API (`GetMyeBaySelling`).
- **30-Day Traffic & Conversion Analytics:** Fetches listing impressions, click-through rate (CTR), page views, and sales conversion metrics via the eBay Sell Analytics API.
- **Automated Listing Audits & Comping:** Benchmarks listing titles (80-character utilization) and asking prices against active marketplace comps (lowest, median, average, and highest prices) via the eBay Browse API.
- **Dual-Grant OAuth 2.0 Token Management:** Automatically manages and caches both Client Credentials application tokens (for public search) and Authorization Code refresh tokens (for seller-scoped endpoints).

## Architecture

```text
AI Client (Cursor / Claude Code)
        │
        ▼  Stdio MCP Transport (JSON-RPC)
eBay MCP Server (Node.js + TypeScript)
        ├──► OAuth 2.0 Token Manager (App & Refresh Token Caching)
        ├──► eBay Browse API (REST/JSON — Public Market Comps)
        ├──► eBay Trading API (XML/HTTPS — Active Seller Listings)
        └──► eBay Sell Analytics API (REST/JSON — Impressions & CTR)
