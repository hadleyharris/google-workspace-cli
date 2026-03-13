# gws-mcp-server

MCP server wrapping the [Google Workspace CLI](https://github.com/googleworkspace/cli) (`gws`). Deploy to Render, authenticate once in your browser, and every Claude client gets access to Drive, Gmail, Calendar, Sheets, Docs, Chat, and Admin APIs.

**Zero local installs.** Everything runs on the server.

## How It Works

```
Claude.ai ──POST /mcp──> gws-mcp-server (Render) ──> gws CLI ──> Google Workspace APIs
```

The server manages OAuth tokens and passes a fresh access token to `gws` on every invocation. Five meta-tools give Claude full access without bloating the context window with hundreds of API method definitions.

| Tool | What it does |
|------|--------------|
| `gws_run` | Execute any gws command (service + resource + method) |
| `gws_schema` | Inspect any API method's parameters |
| `gws_discover` | Browse available services, resources, methods |
| `gws_auth_status` | Check auth state and current user |
| `gws_raw` | Raw shell command for complex cases |

## Setup (One-Time, ~10 min)

### Step 1: Create a GCP OAuth Client

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or use existing)
3. Enable the APIs you want:
   - [Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
   - [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
   - [Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
   - [Sheets API](https://console.cloud.google.com/apis/library/sheets.googleapis.com)
   - [Docs API](https://console.cloud.google.com/apis/library/docs.googleapis.com)
4. Go to [OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent):
   - App type: **External**
   - Add yourself as a **Test user**
5. Go to [Credentials](https://console.cloud.google.com/apis/credentials):
   - Create OAuth client ID
   - Type: **Web application**
   - Add authorized redirect URI: `https://YOUR-SERVICE.onrender.com/auth/callback`
   - Copy the **Client ID** and **Client Secret**

### Step 2: Deploy to Render

1. Push this repo to GitHub
2. Create a new **Web Service** on Render
3. Connect to your repo, select **Docker** runtime
4. Add environment variables:
   - `GOOGLE_CLIENT_ID` = your client ID
   - `GOOGLE_CLIENT_SECRET` = your client secret
5. Optionally attach a **Disk** mounted at `/data` (1 GB) to persist tokens across redeploys
6. Deploy

### Step 3: Authenticate

1. Visit `https://YOUR-SERVICE.onrender.com/auth/login`
2. Sign in with your Google account, approve scopes
3. You'll see a success page with your refresh token
4. **Copy the refresh token** and set it as `GWS_REFRESH_TOKEN` env var on Render (this makes auth survive redeploys even without a disk)

### Step 4: Connect Claude

Add the MCP server in Claude.ai (or any MCP client):
- URL: `https://YOUR-SERVICE.onrender.com/mcp`

## Usage Examples

Once connected, Claude can run commands like:

```
# List recent Drive files
gws_run(service="drive", args=["files", "list", "--params", '{"pageSize": 10, "orderBy": "modifiedTime desc"}'])

# Search Gmail
gws_run(service="gmail", args=["users", "messages", "list", "--params", '{"userId": "me", "q": "from:investor subject:term sheet", "maxResults": 5}'])

# Read a spreadsheet
gws_run(service="sheets", args=["spreadsheets", "values", "get", "--params", '{"spreadsheetId": "abc123", "range": "Sheet1!A1:D10"}'])

# Create a calendar event
gws_run(service="calendar", args=["events", "insert", "--params", '{"calendarId": "primary"}', "--json", '{"summary": "Team sync", "start": {"dateTime": "2026-03-15T10:00:00-05:00"}, "end": {"dateTime": "2026-03-15T10:30:00-05:00"}}'])

# Discover what's available
gws_discover(service="drive")
gws_schema(method="drive.files.list")
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_CLIENT_ID` | Yes | OAuth client ID from GCP |
| `GOOGLE_CLIENT_SECRET` | Yes | OAuth client secret from GCP |
| `GWS_REFRESH_TOKEN` | No* | Refresh token (set after first /auth/login to persist) |
| `GWS_SCOPES` | No | Space-separated OAuth scopes (has sensible defaults) |
| `PORT` | No | Server port (default: 3000, Render sets this) |
| `DATA_DIR` | No | Token storage directory (default: /data) |
| `GWS_TIMEOUT` | No | Command timeout in ms (default: 30000) |

*Strongly recommended after first auth

## Token Persistence

Tokens are persisted three ways (checked in order):

1. `GWS_REFRESH_TOKEN` env var (survives anything)
2. `GWS_TOKENS_JSON` env var (full token blob)
3. `/data/tokens.json` file (survives redeploys if you attach a Render disk)

If none exist, the server starts unauthenticated and you visit `/auth/login`.

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Landing page with auth status |
| `/auth/login` | GET | Start OAuth flow (opens Google consent) |
| `/auth/callback` | GET | OAuth redirect handler |
| `/auth/status` | GET | Auth status as JSON |
| `/health` | GET | Health check |
| `/mcp` | POST | MCP protocol endpoint |

## Important Notes

- `gws` is pre-v1.0 (currently 0.8.0). Expect some rough edges.
- The OAuth client must be **Web application** type (not Desktop) since the server handles the redirect.
- If your GCP app is in "testing mode", only test users can authenticate. Add yourself under OAuth consent screen > Test users.
- The `gws` CLI dynamically discovers Google APIs at runtime, so new Workspace endpoints are automatically available.

## License

Apache-2.0
