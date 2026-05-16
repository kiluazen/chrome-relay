import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

export interface FixtureServer {
  url: (path: string) => string;
  origin: string;
  close: () => Promise<void>;
}

export async function startFixtureServer(fixturesDir?: string): Promise<FixtureServer> {
  const root = fixturesDir ?? resolve(__dirname, "..", "fixtures");

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://placeholder");
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      const filePath = resolve(root, "." + path);
      if (!filePath.startsWith(root) || !existsSync(filePath)) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const body = await readFile(filePath);
      res.statusCode = 200;
      res.setHeader("content-type", MIME[extname(filePath)] ?? "application/octet-stream");
      res.setHeader("cache-control", "no-store");
      // Force the connection closed so Chromium doesn't keep keep-alive sockets
      // open across tests — that would block server.close() during teardown.
      res.setHeader("connection", "close");
      res.end(body);
    } catch (err) {
      res.statusCode = 500;
      res.end((err as Error).message);
    }
  });

  // Drop idle keep-alive sockets fast so close() completes quickly.
  server.keepAliveTimeout = 200;
  server.headersTimeout = 1000;

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture server failed to bind a port.");
  }

  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    url: (path) => origin + (path.startsWith("/") ? path : "/" + path),
    close: () => new Promise<void>((resolveClose) => {
      // Force-close any lingering sockets, then close the listener.
      server.closeAllConnections?.();
      server.close(() => resolveClose());
    })
  };
}
