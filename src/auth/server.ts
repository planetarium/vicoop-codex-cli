import * as http from "node:http";
import { AddressInfo } from "node:net";
import {
  DEFAULT_LOCAL_PORT,
  FALLBACK_LOCAL_PORT,
  REDIRECT_PATH,
} from "./constants.js";

export interface CallbackResult {
  code: string;
  state: string;
}

export interface CallbackServer {
  port: number;
  redirectUri: string;
  waitForCallback: (expectedState: string) => Promise<CallbackResult>;
  close: () => void;
}

const SUCCESS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>vicoop-codex login</title>
    <style>
      body { font-family: -apple-system, system-ui, sans-serif; background: #0f1115; color: #e6e6e6; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
      .card { text-align: center; padding: 32px 40px; border-radius: 12px; background: #1a1d24; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
      h1 { margin: 0 0 8px; font-size: 20px; }
      p { margin: 0; color: #9aa0a6; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Login successful</h1>
      <p>You can close this tab and return to your terminal.</p>
    </div>
  </body>
</html>`;

function errorHtml(message: string): string {
  return `<!doctype html><html><body style="font-family:system-ui;padding:32px"><h1>Login failed</h1><pre>${escapeHtml(
    message,
  )}</pre></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function tryListen(port: number): Promise<http.Server | null> {
  return new Promise((resolve) => {
    const server = http.createServer();
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      if (err.code === "EADDRINUSE" || err.code === "EACCES") {
        resolve(null);
      } else {
        resolve(null);
      }
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: "127.0.0.1", port });
  });
}

export async function startCallbackServer(): Promise<CallbackServer> {
  let server = await tryListen(DEFAULT_LOCAL_PORT);
  let port = DEFAULT_LOCAL_PORT;
  if (!server) {
    server = await tryListen(FALLBACK_LOCAL_PORT);
    port = FALLBACK_LOCAL_PORT;
  }
  if (!server) {
    throw new Error(
      `Could not bind a local callback server on ports ${DEFAULT_LOCAL_PORT} or ${FALLBACK_LOCAL_PORT}. Close other apps using these ports and retry.`,
    );
  }

  const addr = server.address() as AddressInfo;
  port = addr.port;
  const redirectUri = `http://localhost:${port}${REDIRECT_PATH}`;

  const httpServer = server;

  const waitForCallback = (expectedState: string) =>
    new Promise<CallbackResult>((resolve, reject) => {
      const onRequest = (
        req: http.IncomingMessage,
        res: http.ServerResponse,
      ) => {
        const url = new URL(req.url ?? "/", `http://localhost:${port}`);
        if (url.pathname !== REDIRECT_PATH) {
          res.statusCode = 404;
          res.setHeader("content-type", "text/plain");
          res.end("not found");
          return;
        }
        const params = url.searchParams;
        const err = params.get("error");
        if (err) {
          const desc = params.get("error_description") ?? "";
          res.statusCode = 400;
          res.setHeader("content-type", "text/html");
          res.end(errorHtml(`${err}: ${desc}`));
          httpServer.removeListener("request", onRequest);
          reject(new Error(`OAuth error: ${err}${desc ? ` — ${desc}` : ""}`));
          return;
        }
        const code = params.get("code");
        const state = params.get("state");
        if (!code || !state) {
          res.statusCode = 400;
          res.setHeader("content-type", "text/html");
          res.end(errorHtml("Missing code or state parameter"));
          httpServer.removeListener("request", onRequest);
          reject(new Error("OAuth callback missing code or state"));
          return;
        }
        if (state !== expectedState) {
          res.statusCode = 400;
          res.setHeader("content-type", "text/html");
          res.end(errorHtml("State mismatch — possible CSRF"));
          httpServer.removeListener("request", onRequest);
          reject(new Error("OAuth state mismatch"));
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(SUCCESS_HTML);
        httpServer.removeListener("request", onRequest);
        resolve({ code, state });
      };
      httpServer.on("request", onRequest);
    });

  return {
    port,
    redirectUri,
    waitForCallback,
    close: () => {
      try {
        httpServer.close();
      } catch {
        // ignore
      }
    },
  };
}
