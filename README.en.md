# dsh-plugin-restart-control

[中文](README.md) | English

Adds a **Restart** section to the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) settings page, with two tiers:

| Tier | What it does | Cost |
|---|---|---|
| **Reload kernel** | Asks DSH's own HMR to re-compose the whole plugin tree (config re-read, plugins remounted) | Seconds; process and window preserved; **does not** pick up new package versions or native modules |
| **Restart application** | A detached helper ends the shell process and relaunches the same executable | Thorough; interrupts running tasks; window is recreated |

## Why these two tiers

In the official desktop build (Electron shell + host child process), a "kernel process restart" is not available to a plugin:

- **A plugin cannot reach the shell.** The IPC between the host and the Electron main process is a closed allowlist (`dsh-desktop-host`'s `process.on("message")` accepts only `shutdown` / `quit-inspection` / `update-tasks`); anything else gets the host `SIGTERM`ed. So a plugin cannot ask the shell to run `app.relaunch()`.
- **The host cannot restart itself either.** The main process treats any unsolicited host exit as a failure (`dsh desktop host stopped`, `acknowledged an unrequested shutdown`) and raises the crash-recovery dialog. Only the main process restarts the host, and only inside its update flow.

So this plugin ships the strongest two tiers that are actually reachable, and they are exactly the two paths DSH itself uses:

- **Reload kernel** = the official HMR path. It appends/updates one timestamped comment line (`# dsh-plugin-restart-control: kernel reload marker …`) in the active profile's `cordis.patch.yml`; HMR sees a configuration-layer change and re-composes the tree. This is the same mechanism `dsh-market` uses for plugin toggles — **only that one line is ever touched; none of your configuration is modified**.
- **Restart application** = the detached-helper path. The helper starts via `process.execPath` with `ELECTRON_RUN_AS_NODE=1` (no system Node required), ends the shell (which drops the host's IPC and lets it shut down gracefully), force-kills the host as a fallback, waits for the port to free, then relaunches the executable. It always kills **by PID** — the helper shares the target's image name, so `taskkill /IM` would take the helper down too.

## Install

> ⚠️ **Installing is not enabling.** `dsh plugin add` only installs the package into the profile; it does **not** add it to the profile's bundle list. Open **Settings → Plugins** and switch `dsh-plugin-restart-control` on (equivalent to adding it to `dsh.profile.bundles`), or it will never load. The official plugin manager (settings page / `plugin_manager` tool) performs this step for you.

### 1. GitHub (recommended)

```bash
dsh plugin --profile <profile> add "github:MerlinShieh/dsh-plugin-restart-control"
```

pnpm resolves and installs it in about five seconds as `dsh-plugin-restart-control`.

### 2. Release tarball (offline / air-gapped)

```bash
dsh plugin --profile <profile> add https://github.com/MerlinShieh/dsh-plugin-restart-control/releases/download/v0.1.0/dsh-plugin-restart-control-0.1.0.tgz
```

### 3. Official desktop build (settings page)

The desktop build owns the `desktop` profile: an external CLI answers `profile "desktop" is managed exclusively by the Electron application`. Use **Settings → Plugins → Add plugin** with any spec above, then switch the bundle on.

### 4. Local path (development)

```bash
pnpm add file:/absolute/path/dsh-plugin/restart-control
```

`file:` installs are a **snapshot** — re-run `pnpm add` after changing the source. The plugin lives under `node_modules`, which DSH's HMR does not watch, so **host-half changes need an application restart**.

> **The npm package is not published yet.** Once `dsh-plugin-restart-control` is on npm, `dsh plugin --profile <profile> add dsh-plugin-restart-control` will work with exactly the same experience as the shipped plugins (version ranges and `pnpm update` included).

## Usage

Open **Settings → Restart / 重启**:

- **Reload kernel** — one click writes the marker and triggers the hot re-composition.
- **Restart application** — asks for **confirmation** first (so a stray click cannot interrupt work), then reports "restarting"; the page comes back once the app is up.
- **View restart log** — the helper records every step in `$DSH_HOME/dsh-plugin-restart-control/restart.log`; the settings section shows the tail. This is the only evidence available when a restart fails.

An amber notice appears when tasks are running: restarting the application interrupts them, reloading the kernel does not.

## Security model

Control routes accept only: a **loopback** (or `webRuntime.trustedHosts`) Host header, **same-origin** browser markers (`Sec-Fetch-Site` not `cross-site`, `Origin` matching Host), and `content-type: application/json` POSTs capped at 64 KiB. This is a DNS-rebinding / cross-site fence, not authentication — the same policy as `dsh-dream-skin` and `dsh-better-sidebar`.

## Compatibility

- `peerDependencies` use ranges (`>=0.1.0-rc.6 <0.3.0-0`), so it passes the official compatibility check on DSH `0.2.0-rc.2`.
- The host half needs `webServer` and `webRuntime`; without them the plugin simply does not mount (it never fails startup).
- The browser half needs `slots` and `locale`; if a platform seed (`react`, `react/jsx-runtime`) fails to resolve it degrades to "invisible but harmless" with a single console warning.

## Known limitations

- **"Reload kernel" is not a process restart.** It cannot reload modules Node already imported, and it does not release native addons. Use "Restart application" for those.
- **"Restart application" is a forced end.** The helper kills by PID and does not run the shell's `before-quit` confirmation flow. DSH session logs are append-only, so the risk is low, but running tasks are interrupted.
- **Recovery is minimal.** The helper only writes a log — there is no recovery page like `dsh-market`'s. If the app does not come back, start it manually and read the log.
- The kernel trigger requires the profile's `cordis.patch.yml` to exist and be non-empty; otherwise "Reload kernel" returns `patch-missing` and stays disabled.

## Development

The browser half is **source-as-artifact** (`lib/client.js` *is* the shippable bundle, built from `react/jsx-runtime` calls instead of JSX), so there is **no build step**:

```
lib/index.js           host half (ESM)
lib/restart-helper.js  detached helper source (exported as a template string)
lib/client.js          browser bundle (registered via window.__ModuleLoader__.load)
cordis.patch.yml       profile patch layer: inserts one loader entry
locale/{zh,en}.json    plugin metadata localization
```

Reinstall into the target profile (`pnpm add file:...`) or hot-reload after a change.

## License

MIT
