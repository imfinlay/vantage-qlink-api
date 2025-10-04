# Split Routes into their own js files for neatness and ease of maintenance

- `src/index.js` — entrypoint for HTTP server
- `src/app.js` — builds Express app, mounts routes, serves static `public/`
- `src/core/*` — shared logic (context, logger, tcp, queue, parsing, whitelist, state)
- `src/routes/*` — grouped route files (`core`, `connection`, `io`, `test`, `vgs`, `admin`, `whitelist`)
- `src/config.js` — shim that re-exports your root `config.js`
- `ecosystem.config.js` — PM2 config targeting `src/index.js`

> Nothing in the root (`app.js`, `public/`, `commands.csv`, `config.js`) is overwritten by this patch.

### Serving static files
By default we serve `<repo>/public` (same as before). You can override with env:

```bash
PUBLIC_DIR=/absolute/path/to/public pm2 start src/index.js --name vantage-qlink-api
```

### Notes
- `commands.csv` is still read from the **repo root**.
- `config.js` stays at the **repo root**. The shim `src/config.js` simply forwards to it.
- All TCP/logging/queue/parsing behavior is preserved. 
