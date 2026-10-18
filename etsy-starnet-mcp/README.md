# Etsy MCP starter for StarNet

**Using Render? Open `RENDER-SETUP.md` first.** It contains the exact service fields and environment settings. Render supplies HTTPS, so Caddy and Docker Compose are unnecessary there.

Rebuilt replacement, 18 October 2026. The original `/mnt/data` ZIP and README were absent in this Windows session, so their integrity could not be assessed. This package is newly built rather than recovered. No user credentials are included.

## Open the files

Download the ZIP, right-click it in Windows Explorer, choose **Extract All**, and open the extracted `etsy-starnet-mcp` folder. Open `README.md` with Notepad or a code editor. Source files are text; double-clicking them does not start the server. Node.js 22 or newer is required. No npm dependencies or install step are required.

## What is included

Single-shop, single-process hosted MCP server; Etsy authorization code flow with S256 PKCE; one-use, ten-minute, browser-bound state; AES-256-GCM encrypted access/refresh token storage; refresh on demand; physical listing draft creation; JPEG/PNG upload; opt-in activation. MCP transport is stateless Streamable HTTP with JSON responses, protocol revision `2025-03-26`. No SSE stream, multi-user tenancy, scheduling, digital file upload, or downstream OAuth authorization server is included.

Etsy sign-in and MCP client authentication are separate. Etsy uses OAuth2 PKCE. StarNet authenticates to this starter using a dedicated bearer token. If StarNet accepts only OAuth discovery or legacy SSE and cannot send a custom Authorization header to Streamable HTTP, this starter needs an authentication/transport adapter. The previous chat's StarNet screenshot was unavailable; compatibility with its exact fields has not been verified. Do not put Etsy tokens or the Etsy shared secret into StarNet.

## Configure securely

1. Register an Etsy API app at https://www.etsy.com/developers/your-apps. Use newly issued credentials if prior credentials were shared in chat. Keep the app's approved access level and shop restrictions in mind.
2. Choose a domain, for example `etsy.yourdomain.com`. Register exactly `https://etsy.yourdomain.com/oauth/callback` as the Etsy redirect URI. HTTPS and exact spelling matter.
3. Copy `.env.example` to `.env`. Set `PUBLIC_URL` to your HTTPS origin without a path; set `ETSY_CLIENT_ID` to the app keystring, `ETSY_SHARED_SECRET` to its shared secret, and `ETSY_SHOP_ID` to your numeric shop ID. Configure only on the server or in your hosting provider's secret manager.
4. Generate three independent values, running this command three times:

   ```text
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   ```

   Put the first into `MCP_BEARER_TOKEN`, the second into `ADMIN_BEARER_TOKEN`, and the third into `TOKEN_ENCRYPTION_KEY`. Never reuse the same value. Keep the encryption key backed up separately from token storage. Losing it requires reconnecting Etsy.
5. Keep `ALLOW_PUBLISH=false` until draft/image tools work. Protect `.env` using owner-only file permissions. Never commit it or include it in another ZIP. On Windows restrict its ACL to your user and administrators; on Linux use `chmod 600 .env`.

## Deploy with HTTPS

Use a Linux host with Docker Engine and the Docker Compose plugin. Point your domain's DNS to that host. Allow inbound TCP 80 and 443; do not expose port 3000. Edit the domain in `Caddyfile` to match `PUBLIC_URL`. From the extracted folder:

```text
docker compose up -d --build
docker compose ps
```

Caddy obtains and renews a TLS certificate. The app is accessible only through the proxy. Open `https://YOUR_DOMAIN/healthz`; expect `{"ok":true}`. Put firewall or edge rate limits on the public host (especially `/admin/connect` and `/mcp`) appropriate to your traffic. Avoid proxy access logs that include callback query strings or credentials.

The named `tokens` volume persists encrypted credentials; Caddy volumes persist certificates. Back up encrypted token storage and keep its key separately. Run exactly one app replica: in-memory authorization sessions and refresh serialization are process-local. For scaling, replace them with shared storage and distributed locking. Existing pending sign-in sessions are lost on restart. Do not run `docker compose down -v` unless you intend to delete volumes.

For local development behind an HTTPS tunnel/proxy, use `npm start` after creating `.env`; preserve the configured public Host header. The app binds to loopback by default. Etsy callback and the Secure cookie require browser HTTPS; plain localhost HTTP is insufficient for connecting Etsy.

## Connect Etsy once

Open `https://YOUR_DOMAIN/admin` in your browser. Enter `ADMIN_BEARER_TOKEN`, click **Connect Etsy**, and approve access on Etsy. The browser returns to `/oauth/callback` and displays `connected: true`. The server verifies the consenting user owns `ETSY_SHOP_ID` before saving credentials. Scopes requested: `shops_r listings_r listings_w`. The admin token never belongs in a URL. Only the saved encrypted token file is persistent; OAuth session cookies are short-lived.

## Connect StarNet

If its connector supports Streamable HTTP plus custom headers, configure:

```text
URL: https://YOUR_DOMAIN/mcp
Transport: Streamable HTTP
Header name: Authorization
Header value: Bearer YOUR_MCP_BEARER_TOKEN
```

Use the generated MCP token locally in that field. Do not use the admin token. Initialize MCP, discover tools, then call `etsy_status`. For a manual PowerShell smoke check:

```powershell
$token = Read-Host 'MCP bearer token' -MaskInput
$headers = @{ Authorization = "Bearer $token"; Accept = 'application/json, text/event-stream' }
$body = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"manual-check","version":"1"}}}'
Invoke-RestMethod -Uri 'https://YOUR_DOMAIN/mcp' -Method Post -Headers $headers -ContentType 'application/json' -Body $body
```

`-MaskInput` requires PowerShell 7. On Windows PowerShell 5, use the admin page for sign-in and StarNet for the MCP check, or use a secret-capable API client.

## Create and publish

Call `etsy_create_draft` with the object below, replacing the category, shipping and readiness IDs with valid values for your shop. The starter handles physical listings only. Manage shipping/processing profiles in Etsy first; consult Etsy's API reference for the corresponding IDs. Prices use the shop currency's major units.

```json
{
  "quantity": 1,
  "title": "Your product title",
  "description": "Your accurate product description",
  "price": 12.5,
  "who_made": "i_did",
  "when_made": "made_to_order",
  "taxonomy_id": 123,
  "shipping_profile_id": 123,
  "readiness_state_id": 123
}
```

Save the returned `listing_id`. Call `etsy_upload_image` with that ID and `image_base64` containing raw base64 of a JPEG or PNG, without a data-URL prefix (5 MiB decoded maximum). You can also upload the image through Etsy's UI. Etsy validates category, policy, processing, inventory and other listing requirements; this minimal tool does not expose every optional API field.

To permit unattended activation, set `ALLOW_PUBLISH=true` and recreate the app with `docker compose up -d --force-recreate app`. Then call `etsy_publish_listing` with `{"listing_id":YOUR_LISTING_ID}`. This publishes live and may incur Etsy fees. Etsy requires listing imagery and other applicable fields. This setting authorizes all holders of the MCP token to publish for this shop; protect that token accordingly. The server refreshes access on demand without a new browser login while the Etsy grant remains valid. Revoked or expired refresh grants require reconnecting. No periodic scheduler is included; an external authorized StarNet workflow can call the tool when needed.

Each create call creates another draft: do not automatically retry after an ambiguous timeout. Look in Etsy first and reuse the returned listing ID for later actions. API errors return tool errors without logging response bodies or secrets. Rate limits are surfaced; there are no automatic write retries.

## Verify and troubleshoot

Run `npm test` (no installation needed). Tests use mocked Etsy responses and cover PKCE, encryption/tamper detection, authentication, origin blocking, callback cookies/state/replay, token refresh, API request construction, validation and publishing opt-in. They do not authorize a real Etsy account or verify StarNet's UI, certificate issuance, Docker execution, or a paid live publication.

401: check the MCP bearer header or admin token. 403: check Origin and the proxy's preserved Host. OAuth 400: start again at `/admin`; the state may have expired or cookies may be blocked. Generic callback failure: check exact redirect, shop ownership, credentials, scopes, and Etsy app approval. 500 after moving servers: restore the correct encryption key and token file together, or reconnect Etsy. API 429: wait according to Etsy rate limits before a deliberate retry. Missing files after extraction: extract the whole archive including dotfiles; do not run from inside the ZIP.

Official references checked for this rebuild:

- https://developers.etsy.com/documentation/essentials/authentication/
- https://developers.etsy.com/documentation/tutorials/listings/
- https://developers.etsy.com/documentation/reference/
- https://modelcontextprotocol.io/specification/2025-03-26/basic/transports

See `VERIFICATION.txt` for the completed local checks. The adjacent ZIP checksum can verify download integrity.
