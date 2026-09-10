#!/usr/bin/env node
/**
 * MCP over streamable HTTP — for running the server somewhere and pointing a
 * remote client at it.
 *
 * Requires MCP_TOKEN, and refuses to start without one: this endpoint can move
 * real money around, so an unauthenticated port is never the right default.
 */

import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.js";

const PORT = Number(process.env.MCP_PORT ?? 8790);
const HOST = process.env.MCP_HOST ?? "0.0.0.0";
const TOKEN = process.env.MCP_TOKEN;

if (!TOKEN) {
  console.error("MCP_TOKEN is required: this endpoint can create and delete transactions.");
  process.exit(1);
}

const server = createServer((req, res) => {
  const path = (req.url ?? "").split("?")[0];

  if (path === "/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    return;
  }
  if (path !== "/mcp") {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found\n");
    return;
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized\n");
    return;
  }

  /**
   * Stateless: a fresh server per request, no session table. Remote clients
   * reconnect freely and sessions would only be state to lose on restart.
   */
  void (async () => {
    const mcp = createMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.writeHead(500).end();
    } finally {
      void mcp.close();
    }
  })();
});

server.listen(PORT, HOST, () => {
  console.error(`moneylover mcp listening on http://${HOST}:${PORT}/mcp`);
});
