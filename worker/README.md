# Deploying the LALAL.AI proxy Worker

PerfectPitch-1 needs this small proxy because LALAL.AI's API blocks direct
calls from a browser (confirmed: their CORS preflight response doesn't
allowlist the `X-License-Key` header their own docs say to send). The Worker
makes that one server-to-server hop instead, and holds your LALAL.AI license
key as a secret — it's never in this app's source or stored on your device.

No local tooling needed (no Node, no CLI) — everything below happens in the
Cloudflare dashboard in a browser.

## 1. Create a Cloudflare account

Go to <https://dash.cloudflare.com/sign-up> and sign up (free tier is
plenty — Workers' free plan includes 100,000 requests/day, far more than a
personal karaoke app will ever use).

## 2. Create the Worker

1. In the dashboard sidebar, go to **Workers & Pages**.
2. Click **Create** → **Create Worker**.
3. Give it a name (e.g. `perfectpitch-proxy`) — this becomes part of its
   URL: `https://perfectpitch-proxy.<your-subdomain>.workers.dev`. Note
   that full URL down; you'll need it in step 5.
4. Click **Deploy** to create it with the default "Hello World" script (it
   doesn't matter yet, you'll replace it next).

## 3. Paste in the proxy code

1. Click **Edit code** (or "Continue to project" → the code editor).
2. Select all the default template code and delete it.
3. Paste in the entire contents of [`lalalai-proxy.js`](lalalai-proxy.js)
   from this folder.
4. Click **Deploy** (or **Save and deploy**).

## 4. Add your LALAL.AI license key as a secret

1. Go to the Worker's **Settings** tab → **Variables and Secrets**.
2. Add a new secret:
   - Name: `LALAL_LICENSE_KEY`
   - Value: your LALAL.AI license/activation key
   - Type: **Secret** (not plain text) — this keeps it encrypted at rest
     and out of the dashboard's visible variable list after saving.
3. Save. This may trigger a redeploy — that's expected.

## 5. Confirm the allowed origins match your setup

`lalalai-proxy.js` has an `ALLOWED_ORIGINS` list near the top:

```js
const ALLOWED_ORIGINS = [
  'https://piraterob59.github.io',
  'http://localhost:8081',
];
```

- The GitHub Pages entry should match where PerfectPitch-1 actually ends up
  hosted. If your repo/username differs, update it (GitHub Pages project
  sites are `https://<username>.github.io`, not
  `https://<username>.github.io/<repo>` — the Worker checks the `Origin`
  header, which is just the scheme+host, not the path).
- The `localhost:8081` entry matches the port `.claude/launch.json` uses
  for local dev — update it if that ever changes.

If you change this list, paste the updated file back into the Worker's code
editor and redeploy.

## 6. Point the app at your Worker

Open `js/lalalai.js` in this repo and change:

```js
const PROXY_BASE_URL = 'TODO_SET_ME';
```

to your Worker's actual URL from step 2, e.g.:

```js
const PROXY_BASE_URL = 'https://perfectpitch-proxy.<your-subdomain>.workers.dev';
```

## 7. Test it

With the local dev server running, try importing a short song from
PerfectPitch-1's Library screen. If something's wrong, the browser
console will show either:

- A CORS error naming an origin — means `ALLOWED_ORIGINS` (step 5) doesn't
  match where you're actually running from.
- A `403 Forbidden` from the Worker itself — same cause, checked server-side.
- A `401`/`403` from LALAL.AI's own API (visible in the Worker's response
  body) — means the `LALAL_LICENSE_KEY` secret (step 4) is missing or wrong.

## Notes

- **Why not just skip the Worker and use a different provider?** We looked —
  most stem-separation APIs are built for server-side callers, not browsers,
  for the same reason LALAL.AI is. A small proxy is the standard fix for
  "browser can't call a third-party API directly," not a LALAL.AI-specific
  workaround.
- **Storage cleanup**: the app calls LALAL.AI's `/delete/` endpoint after
  downloading stems, so processed files don't pile up in your LALAL.AI
  account storage. That call is best-effort (fire-and-forget) — if it fails,
  it won't fail the import itself.
