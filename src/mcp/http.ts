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
import { bearerAuthorised } from "./bearer-auth.js";
import { createMcpServer } from "./server.js";

const PORT = Number(process.env.MCP_PORT ?? 8790);
const HOST = process.env.MCP_HOST ?? "0.0.0.0";
const TOKEN = process.env.MCP_TOKEN;

if (!TOKEN) {
  console.error("MCP_TOKEN is required: this endpoint can create and delete transactions.");
  process.exit(1);
}

/**
 * One server for the process.
 *
 * Building it per request would rebuild the client and its cache every time —
 * so `initialize` and `tools/list`, which need no data at all, would each pay
 * for a full read of every group, and the documented five-minute cache would
 * never survive a single request. The transport stays per-request, because a
 * stateless transport is what lets remote clients reconnect freely.
 */
const mcp = createMcpServer();

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
  if (!bearerAuthorised(req.headers.authorization, TOKEN)) {
    res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized\n");
    return;
  }

  void (async () => {
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
      await transport.close();
    }
  })();
});

async function shutdown(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await mcp.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown()
      .catch((error) => {
        console.error(error);
        process.exitCode = 1;
      })
      .finally(() => process.exit());
  });
}

server.listen(PORT, HOST, () => {
  console.error(`moneylover mcp listening on http://${HOST}:${PORT}/mcp`);
});
