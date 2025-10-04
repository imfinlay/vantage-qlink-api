# Split Routes Patch for `vantage-qlink-api`

This zip contains **only the new files** to split your monolithic `app.js` into a modular `src/` layout **without removing any functionality**.

## What’s included
- `src/index.js` — entrypoint for HTTP server
- `src/app.js` — builds Express app, mounts routes, serves static `public/`
- `src/core/*` — shared logic (context, logger, tcp, queue, parsing, whitelist, state)
- `src/routes/*` — grouped route files (`core`, `connection`, `io`, `test`, `vgs`, `admin`, `whitelist`)
- `src/config.js` — shim that re-exports your root `config.js`
- `ecosystem.config.js` — PM2 config targeting `src/index.js`

> Nothing in your root (`app.js`, `public/`, `commands.csv`, `config.js`) is overwritten by this patch.

## How to apply

From your repo root (on Mac or Pi):

```bash
# 1) Unzip into the repository root
unzip vantage-qlink-api-split-patch.zip -d .

# 2) Commit the changes
git add src ecosystem.config.js
git commit -m "Split routes into src/* without behavior change"

# 3) Start with PM2 (uses src/index.js)
pm2 startOrReload ecosystem.config.js
# or
pm2 start src/index.js --name vantage-qlink-api
```

### Serving static files
By default we serve `<repo>/public` (same as before). You can override with env:

```bash
PUBLIC_DIR=/absolute/path/to/public pm2 start src/index.js --name vantage-qlink-api
```

### Notes
- `commands.csv` is still read from the **repo root**.
- `config.js` stays at the **repo root**. The shim `src/config.js` simply forwards to it.
- All TCP/logging/queue/parsing behavior is preserved. If you see any mismatch, ping me and I’ll align it line‑for‑line.
