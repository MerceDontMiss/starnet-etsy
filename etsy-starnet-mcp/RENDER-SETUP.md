# Deploy on Render — start here

## 1. Put the files in a private GitHub repository

Extract the whole ZIP first. Create a new private GitHub repository. Choose **Add file > Upload files** and upload the **contents** of the extracted `etsy-starnet-mcp` folder. `package.json`, `Dockerfile`, `src/`, and this guide should be at the repository root, not inside another `etsy-starnet-mcp` folder. Commit the upload. Do not upload a populated `.env` file or any credentials. Render deploys from a repository or container image; the ZIP itself is not an application upload.

## 2. Create the Render service

In Render choose **New > Web Service**, connect GitHub, and select that repository.

| Setting | Value |
|---|---|
| Name | Your chosen unique service name, e.g. `etsy-starnet` |
| Language / Runtime | **Node** |
| Root Directory | Leave blank if files are at repository root |
| Build Command | `node --check src/server.mjs` |
| Start Command | `node src/server.mjs` |
| Instance | A paid instance that supports a persistent disk |
| Health Check Path | `/healthz` |

Under **Advanced**, add a persistent disk named `etsy-tokens`, mount path **`/var/data`**, size **1 GB**. If you already created the service, add it from the service's **Disks** page before connecting Etsy. The saved OAuth grant must survive restarts; the free ephemeral filesystem does not preserve it. Keep the service at one instance.

## 3. Add environment variables

Use Render's **Environment** settings. Add each row separately; values go in Render, not in GitHub.

| Key | Value |
|---|---|
| `NODE_VERSION` | `22.18.0` |
| `HOST` | `0.0.0.0` |
| `DATA_DIR` | `/var/data` |
| `ETSY_CLIENT_ID` | Your newly issued Etsy app keystring |
| `ETSY_SHARED_SECRET` | Your Etsy app shared secret |
| `ETSY_SHOP_ID` | Your numeric Etsy shop ID |
| `MCP_BEARER_TOKEN` | First generated random value below |
| `ADMIN_BEARER_TOKEN` | Second generated random value below |
| `TOKEN_ENCRYPTION_KEY` | Third generated random value below |
| `ALLOW_PUBLISH` | `false` initially |

Generate the three values on your own computer with Node.js 22 installed:

```text
node -e "for(const k of ['MCP_BEARER_TOKEN','ADMIN_BEARER_TOKEN','TOKEN_ENCRYPTION_KEY']) console.log(k+'='+require('node:crypto').randomBytes(32).toString('base64'))"
```

Copy each value to its matching Render field. Keep a secure copy of the encryption key. No need to set `PORT`; Render supplies it. No need to set `PUBLIC_URL` for the default `onrender.com` address; the code uses Render's `RENDER_EXTERNAL_URL`. For a custom domain, set `PUBLIC_URL=https://YOUR_CUSTOM_DOMAIN` without a trailing slash or path.

Use fresh Etsy credentials because credentials were shared in the earlier conversation. This package deliberately contains none of those values.

## 4. Deploy, then register the callback

Click **Create Web Service**, or **Save, rebuild, and deploy** if updating an existing service. Wait until Render shows it is live. Copy the actual HTTPS service URL shown by Render; do not assume your chosen name is the final address.

In the Etsy developer app settings, register this exact callback, substituting the actual host:

```text
https://YOUR_ACTUAL_SERVICE.onrender.com/oauth/callback
```

Open `https://YOUR_ACTUAL_SERVICE.onrender.com/healthz`. It should display `{"ok":true}`. Then open:

```text
https://YOUR_ACTUAL_SERVICE.onrender.com/admin
```

Enter your **ADMIN_BEARER_TOKEN**, click **Connect Etsy**, and approve access. Success displays `{"connected":true}`. You only need to do this again if the grant expires or is revoked, or you lose stored credentials. A restart during sign-in requires starting that sign-in again.

## 5. Connect StarNet

Configure a remote MCP connection with:

| Field | Value |
|---|---|
| Server URL | `https://YOUR_ACTUAL_SERVICE.onrender.com/mcp` |
| Transport | Streamable HTTP |
| Header name | `Authorization` |
| Header value | `Bearer YOUR_MCP_BEARER_TOKEN` |

Replace `YOUR_MCP_BEARER_TOKEN` with your generated MCP token, including the space after `Bearer`. The Etsy shared secret and admin token do not go in StarNet. This starter uses Etsy OAuth for shop authorization and bearer authentication for the MCP connection. If StarNet's form only offers OAuth client ID/secret and cannot set headers, that form is not compatible with this starter without an additional adapter. The exact StarNet interface was unavailable for verification.

Call `etsy_status`, then follow the example in `README.md` to create a draft and upload its image. When ready to allow unattended live publication, change **ALLOW_PUBLISH** to **true** in Render and redeploy. `etsy_publish_listing` can then activate a prepared listing and incur Etsy fees. There is no built-in scheduler; StarNet must initiate the call.

## If deployment fails

- `Configure ETSY_...`: fill the named missing environment field.
- `TOKEN_ENCRYPTION_KEY must encode 32 bytes`: use the third generated value exactly.
- Token storage write error: verify the disk is attached at `/var/data` and `DATA_DIR` matches it.
- `/admin` or `/mcp` returns 403: make sure the URL matches `PUBLIC_URL`, or remove a stale `PUBLIC_URL` to use Render's automatic URL.
- Callback failure: check exact redirect URI, app approval, current credentials, and that the signed-in Etsy account owns the configured shop ID.

Official Render instructions: https://render.com/docs/web-services and https://render.com/docs/disks . No Render deployment or real Etsy publication was performed during the package rebuild.
