#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const fallbackToken = process.env.WANIKANI_API_TOKEN ?? process.env.WANIKANI_API_KEY;

if (!fallbackToken) {
  console.error(
    "wanikani-mcp: WANIKANI_API_TOKEN is not set; tool calls will fail until it is. " +
      "Create a token at https://www.wanikani.com/settings/personal_access_tokens",
  );
}

const server = createServer({ fallbackToken });
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("wanikani-mcp: stdio server ready");
