import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import crypto from "crypto";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GWS_BIN = process.env.GWS_BIN || "gws";
const EXEC_TIMEOUT = parseInt(process.env.GWS_TIMEOUT || "30000", 10);
const MAX_OUTPUT = parseInt(process.env.GWS_MAX_OUTPUT || "100000", 10);
const PORT = parseInt(process.env.PORT || "3000", 10);

// OAuth config -- set these on Render
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";

// Where to persist tokens on Render disk (survives redeploys if you attach a disk)
const DATA_DIR = process.env.DATA_DIR || "/data";
const TOKEN_FILE = path.join(DATA_DIR, "tokens.json");

// Default scopes -- covers the major Workspace APIs
const DEFAULT_SCOPES = (
  process.env.GWS_SCOPES ||
  [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/chat.messages",
    "https://www.googleapis.com/auth/admin.directory.user.readonly",
    "https://www.googleapis.com/auth/tasks",
  ].join(" ")
);

// ---------------------------------------------------------------------------
// Token management
// ---------------------------------------------------------------------------

interface TokenData {
  access_token: string;
  refresh_token: string;
  expiry: number; // epoch ms
  scopes: string;
}

let tokens: TokenData | null = null;

function saveTokens(t: TokenData): void {
  tokens = t;
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2), "utf-8");
    console.error("[gws-mcp] Tokens saved to disk");
  } catch {
    console.error("[gws-mcp] Could not persist tokens to disk (non-fatal, tokens are in memory)");
  }
}

function loadTokens(): void {
  // Priority 1: env var with refresh token (simplest Render setup)
  if (process.env.GWS_REFRESH_TOKEN && GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
    tokens = {
      access_token: "",
      refresh_token: process.env.GWS_REFRESH_TOKEN,
      expiry: 0,
      scopes: DEFAULT_SCOPES,
    };
    console.error("[gws-mcp] Loaded refresh token from env");
    return;
  }

  // Priority 2: full token JSON from env
  if (process.env.GWS_TOKENS_JSON) {
    try {
      tokens = JSON.parse(process.env.GWS_TOKENS_JSON);
      console.error("[gws-mcp] Loaded tokens from GWS_TOKENS_JSON env");
      return;
    } catch {
      console.error("[gws-mcp] Failed to parse GWS_TOKENS_JSON");
    }
  }

  // Priority 3: persisted file on Render disk
  if (existsSync(TOKEN_FILE)) {
    try {
      tokens = JSON.parse(readFileSync(TOKEN_FILE, "utf-8"));
      console.error("[gws-mcp] Loaded tokens from disk");
      return;
    } catch {
      console.error("[gws-mcp] Failed to read token file");
    }
  }

  console.error("[gws-mcp] No tokens found. Visit /auth/login to authenticate.");
}

async function refreshAccessToken(): Promise<string> {
  if (!tokens?.refresh_token) throw new Error("No refresh token. Visit /auth/login first.");
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set.");

  // If token is still fresh (>60s remaining), return it
  if (tokens.access_token && tokens.expiry > Date.now() + 60_000) {
    return tokens.access_token;
  }

  console.error("[gws-mcp] Refreshing access token...");

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Token refresh failed (${resp.status}): ${err}`);
  }

  const data = (await resp.json()) as { access_token: string; expires_in: number };
  tokens.access_token = data.access_token;
  tokens.expiry = Date.now() + data.expires_in * 1000;
  saveTokens(tokens);

  console.error("[gws-mcp] Access token refreshed");
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Helper: run a gws command with fresh token
// ---------------------------------------------------------------------------

interface GwsResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

async function runGws(args: string[]): Promise<GwsResult> {
  // Get a fresh access token and pass to gws via env
  let accessToken: string;
  try {
    accessToken = await refreshAccessToken();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { stdout: "", stderr: `Auth error: ${msg}`, exitCode: 1, truncated: false };
  }

  const cmd = [GWS_BIN, ...args].join(" ");
  console.error(`[gws-mcp] Running: ${cmd}`);

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: EXEC_TIMEOUT,
      maxBuffer: MAX_OUTPUT * 2,
      env: {
        ...process.env,
        GOOGLE_WORKSPACE_CLI_TOKEN: accessToken,
      },
    });

    const truncated = stdout.length > MAX_OUTPUT;
    return {
      stdout: truncated ? stdout.slice(0, MAX_OUTPUT) + "\n...[truncated]" : stdout,
      stderr,
      exitCode: 0,
      truncated,
    };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean; message?: string };
    if (e.killed) {
      return { stdout: "", stderr: `Command timed out after ${EXEC_TIMEOUT}ms`, exitCode: 124, truncated: false };
    }
    return {
      stdout: e.stdout || "",
      stderr: e.stderr || e.message || "Unknown error",
      exitCode: e.code ?? 1,
      truncated: false,
    };
  }
}

function formatResult(result: GwsResult): string {
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout);
  if (result.stderr && result.exitCode !== 0) parts.push(`[stderr] ${result.stderr}`);
  if (result.exitCode !== 0) parts.push(`[exit code: ${result.exitCode}]`);
  if (result.truncated) parts.push("[output was truncated]");
  return parts.join("\n") || "(no output)";
}

// ---------------------------------------------------------------------------
// MCP Server factory (needed because SSE creates a server per connection)
// ---------------------------------------------------------------------------

function createServer(): McpServer {
  const server = new McpServer({
    name: "gws-mcp-server",
    version: "1.0.0",
  });
  registerTools(server);
  return server;
}

function registerTools(server: McpServer): void {

// ---- Tool: gws_run ----

server.registerTool(
  "gws_run",
  {
    title: "Run GWS Command",
    description: `Execute any Google Workspace CLI (gws) command. The gws CLI provides access to all Google Workspace APIs: Drive, Gmail, Calendar, Sheets, Docs, Chat, Admin, and more.

Commands follow the pattern: <service> <resource> <method> [--params JSON] [--json JSON] [flags]

Common examples:
  - Drive files: service="drive", args=["files", "list", "--params", '{"pageSize": 10}']
  - Gmail messages: service="gmail", args=["users", "messages", "list", "--params", '{"userId": "me", "maxResults": 5}']
  - Gmail send: service="gmail", args=["users", "messages", "send", "--params", '{"userId": "me"}', "--json", '{"raw": "<base64>"}']
  - Calendar events: service="calendar", args=["events", "list", "--params", '{"calendarId": "primary", "maxResults": 10}']
  - Sheets read: service="sheets", args=["spreadsheets", "values", "get", "--params", '{"spreadsheetId": "ID", "range": "Sheet1!A1:C10"}']
  - Docs get: service="docs", args=["documents", "get", "--params", '{"documentId": "ID"}']
  - Upload file: service="drive", args=["files", "create", "--json", '{"name": "report.pdf"}', "--upload", "./report.pdf"]

Use --dry-run flag to preview without executing. Use --page-all to auto-paginate.
Use gws_discover to find available services/methods and gws_schema to inspect method parameters.`,
    inputSchema: {
      service: z.string().describe("Google Workspace service name (e.g. drive, gmail, calendar, sheets, docs, chat, admin, tasks)"),
      args: z.array(z.string()).describe("Arguments after the service name. E.g. for 'gws drive files list --params {...}', pass [\"files\", \"list\", \"--params\", \"{...}\"]"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ service, args }) => {
    const result = await runGws([service, ...args]);
    return { content: [{ type: "text", text: formatResult(result) }] };
  }
);

// ---- Tool: gws_schema ----

server.registerTool(
  "gws_schema",
  {
    title: "Inspect GWS API Schema",
    description: `Inspect the request/response schema for any Google Workspace API method. Returns the JSON schema showing required parameters, request body fields, and response structure.

Examples:
  - method="drive.files.list" shows query parameters for listing files
  - method="gmail.users.messages.get" shows how to fetch a message
  - method="calendar.events.insert" shows fields for creating events
  - method="sheets.spreadsheets.values.get" shows how to read cells`,
    inputSchema: {
      method: z.string().describe("Dot-notation method name, e.g. 'drive.files.list', 'gmail.users.messages.get'"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ method }) => {
    const result = await runGws(["schema", method]);
    return { content: [{ type: "text", text: formatResult(result) }] };
  }
);

// ---- Tool: gws_discover ----

server.registerTool(
  "gws_discover",
  {
    title: "Discover GWS Services and Methods",
    description: `List available Google Workspace services, or list all methods for a specific service.

Call with no service to see all available services.
Call with a service name to see its resources and methods.
Call with service and resource to see methods for that resource.

Examples:
  - service="" -> lists all services (drive, gmail, calendar, etc.)
  - service="drive" -> lists drive resources and methods
  - service="gmail" -> lists gmail resources and methods`,
    inputSchema: {
      service: z.string().default("").describe("Service to inspect. Leave empty to list all services."),
      resource: z.string().default("").describe("Resource within the service to inspect. Leave empty to list all resources."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ service, resource }) => {
    if (!service) {
      const result = await runGws(["--help"]);
      return { content: [{ type: "text", text: formatResult(result) }] };
    }
    const args = resource ? [service, resource, "--help"] : [service, "--help"];
    const result = await runGws(args);
    return { content: [{ type: "text", text: formatResult(result) }] };
  }
);

// ---- Tool: gws_auth_status ----

server.registerTool(
  "gws_auth_status",
  {
    title: "Check GWS Auth Status",
    description: "Check the current authentication status. Shows whether the server has valid tokens and which scopes are available.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    if (!tokens?.refresh_token) {
      return { content: [{ type: "text", text: "Not authenticated. The server admin needs to visit /auth/login on the server URL to authorize." }] };
    }
    try {
      const accessToken = await refreshAccessToken();
      const resp = await fetch("https://www.googleapis.com/oauth2/v1/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const info = await resp.json();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            authenticated: true,
            email: (info as Record<string, unknown>).email,
            scopes: tokens!.scopes,
            token_expires: new Date(tokens!.expiry).toISOString(),
          }, null, 2),
        }],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Auth check failed: ${msg}` }] };
    }
  }
);

// ---- Tool: gws_raw ----

server.registerTool(
  "gws_raw",
  {
    title: "Run Raw GWS Command",
    description: `Execute a raw gws command string for maximum flexibility (piping, complex flags, page-all, etc).
The string is passed directly to the shell after prepending 'gws'.

Example: raw_args="drive files list --params '{\"pageSize\": 5}' --page-all --page-limit 2"`,
    inputSchema: {
      raw_args: z.string().describe("Everything after 'gws' as a single string"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ raw_args }) => {
    let accessToken: string;
    try {
      accessToken = await refreshAccessToken();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `Auth error: ${msg}` }] };
    }

    const cmd = `${GWS_BIN} ${raw_args}`;
    console.error(`[gws-mcp] Raw: ${cmd}`);
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        timeout: EXEC_TIMEOUT,
        maxBuffer: MAX_OUTPUT * 2,
        env: { ...process.env, GOOGLE_WORKSPACE_CLI_TOKEN: accessToken },
        shell: "/bin/bash",
      });
      const truncated = stdout.length > MAX_OUTPUT;
      const output = truncated ? stdout.slice(0, MAX_OUTPUT) + "\n...[truncated]" : stdout;
      return { content: [{ type: "text", text: output || stderr || "(no output)" }] };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      const parts = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n");
      return { content: [{ type: "text", text: parts || "Command failed" }] };
    }
  }
);

} // end registerTools

// ---------------------------------------------------------------------------
// Express app: OAuth flow + MCP endpoint
// ---------------------------------------------------------------------------

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json());

  // CORS -- needed for Claude.ai browser-based MCP connections
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (_req.method === "OPTIONS") {
      res.status(200).end();
      return;
    }
    next();
  });

  // ----- Health -----
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: "gws-mcp-server",
      version: "1.0.0",
      authenticated: !!tokens?.refresh_token,
    });
  });

  // ----- OAuth: Step 1 -- redirect to Google -----
  app.get("/auth/login", (req, res) => {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      res.status(500).send("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars must be set on Render.");
      return;
    }

    // Build redirect URI from the request (works with whatever Render domain you get)
    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const redirectUri = `${proto}://${host}/auth/callback`;

    const state = crypto.randomBytes(16).toString("hex");

    const scopes = (req.query.scopes as string) || DEFAULT_SCOPES;

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", scopes + " https://www.googleapis.com/auth/userinfo.email");
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
    authUrl.searchParams.set("state", state);

    console.error(`[gws-mcp] OAuth redirect -> Google consent`);
    res.redirect(authUrl.toString());
  });

  // ----- OAuth: Step 2 -- handle callback -----
  app.get("/auth/callback", async (req, res) => {
    const code = req.query.code as string;
    if (!code) {
      res.status(400).send("Missing authorization code");
      return;
    }

    const proto = req.headers["x-forwarded-proto"] || req.protocol;
    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const redirectUri = `${proto}://${host}/auth/callback`;

    try {
      const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });

      if (!tokenResp.ok) {
        const err = await tokenResp.text();
        res.status(500).send(`Token exchange failed: ${err}`);
        return;
      }

      const data = (await tokenResp.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in: number;
        scope: string;
      };

      if (!data.refresh_token) {
        res.status(500).send(
          "No refresh token received. You may need to revoke this app's access at " +
          "https://myaccount.google.com/permissions and try /auth/login again."
        );
        return;
      }

      saveTokens({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expiry: Date.now() + data.expires_in * 1000,
        scopes: data.scope,
      });

      // Fetch user info
      const userResp = await fetch("https://www.googleapis.com/oauth2/v1/userinfo", {
        headers: { Authorization: `Bearer ${data.access_token}` },
      });
      const user = (await userResp.json()) as { email?: string };

      res.send(`
        <html>
        <body style="font-family: system-ui; max-width: 600px; margin: 60px auto; line-height: 1.6;">
          <h1>Authenticated</h1>
          <p>Signed in as <strong>${user.email || "unknown"}</strong></p>
          <p>Scopes: <code style="font-size: 12px;">${data.scope}</code></p>
          <p>The MCP server is ready. You can close this tab.</p>
          <hr>
          <p style="color: #666; font-size: 14px;">
            <strong>Tip:</strong> To persist auth across Render redeploys, copy the refresh token
            below and set it as <code>GWS_REFRESH_TOKEN</code> env var on Render:<br><br>
            <code style="word-break: break-all; background: #f0f0f0; padding: 8px; display: block; font-size: 12px;">
              ${data.refresh_token}
            </code>
          </p>
        </body>
        </html>
      `);

      console.error(`[gws-mcp] Authenticated as ${user.email}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).send(`OAuth callback error: ${msg}`);
    }
  });

  // ----- Auth status (browser) -----
  app.get("/auth/status", async (_req, res) => {
    if (!tokens?.refresh_token) {
      res.json({ authenticated: false, message: "Visit /auth/login to authenticate" });
      return;
    }
    try {
      const accessToken = await refreshAccessToken();
      const userResp = await fetch("https://www.googleapis.com/oauth2/v1/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const user = (await userResp.json()) as { email?: string };
      res.json({
        authenticated: true,
        email: user.email,
        scopes: tokens.scopes,
        token_expires: new Date(tokens.expiry).toISOString(),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.json({ authenticated: false, error: msg });
    }
  });

  // ----- MCP: Legacy SSE transport (what Claude.ai uses) -----
  const sseTransports = new Map<string, { transport: SSEServerTransport; server: McpServer }>();

  app.get("/sse", async (_req, res) => {
    console.error("[gws-mcp] SSE connection established");
    const transport = new SSEServerTransport("/messages", res);
    const mcpServer = createServer();
    sseTransports.set(transport.sessionId, { transport, server: mcpServer });
    res.on("close", () => {
      console.error(`[gws-mcp] SSE session ${transport.sessionId} closed`);
      sseTransports.delete(transport.sessionId);
    });
    await mcpServer.connect(transport);
  });

  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const entry = sseTransports.get(sessionId);
    if (!entry) {
      res.status(400).json({ error: "Unknown session" });
      return;
    }
    await entry.transport.handlePostMessage(req, res);
  });

  // ----- MCP: Streamable HTTP transport (newer protocol) -----
  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    const mcpServer = createServer();
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", (_req, res) => {
    res.writeHead(405).end(JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST." },
      id: null,
    }));
  });

  app.delete("/mcp", (_req, res) => {
    res.writeHead(405).end(JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    }));
  });

  // ----- Root: landing page -----
  app.get("/", (_req, res) => {
    const authed = !!tokens?.refresh_token;
    res.send(`
      <html>
      <body style="font-family: system-ui; max-width: 600px; margin: 60px auto; line-height: 1.6;">
        <h1>gws-mcp-server</h1>
        <p>MCP server wrapping the Google Workspace CLI.</p>
        <p>Status: ${authed ? "Authenticated" : "<strong>Not authenticated</strong>"}</p>
        <ul>
          <li><a href="/auth/login">Authenticate with Google</a></li>
          <li><a href="/auth/status">Auth status (JSON)</a></li>
          <li><a href="/health">Health check</a></li>
        </ul>
        <p>MCP endpoint: <code>POST /mcp</code></p>
        ${!authed ? '<p style="color: red;">Click "Authenticate with Google" above to get started.</p>' : ""}
      </body>
      </html>
    `);
  });

  app.listen(PORT, () => {
    console.error(`[gws-mcp] Server running at http://0.0.0.0:${PORT}`);
    console.error(`[gws-mcp] MCP endpoint: http://0.0.0.0:${PORT}/mcp`);
    console.error(`[gws-mcp] OAuth login: http://0.0.0.0:${PORT}/auth/login`);
    if (tokens?.refresh_token) {
      console.error("[gws-mcp] Tokens loaded -- ready to serve");
    } else {
      console.error("[gws-mcp] No tokens -- visit /auth/login to authenticate");
    }
  });
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

loadTokens();
startServer().catch((err) => {
  console.error("[gws-mcp] Fatal:", err);
  process.exit(1);
});
