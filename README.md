# bb-plugin-netbird

BB plugin that connects *this machine* to a self-hosted NetBird mesh via the
OAuth **device-code** flow and shows live connection status.

- **Sidebar page** — `NetBird` in the bb sidebar: connection state,
  management/signal/relay status, mesh IP, peer list. A device-code card
  appears during login with the login URL and user code.
- **CLI** — `bb netbird status` / `bb netbird up [--wait]` / `bb netbird down`
  (works from agents too, via the bundled skill).
- **Realtime** — the page updates automatically when the device flow
  produces a login URL or the flow finishes.

Settings (`bb plugin config netbird`):

| Key | Default | Meaning |
| --- | --- | --- |
| `managementUrl` | `https://netbird.clush.net` | self-hosted NetBird management URL |
| `netbirdBin` | `netbird` | path to the netbird CLI binary |

The machine needs a working `netbird` CLI whose build supports the device
authorization grant (self-hosted IdP endpoints are derived from the
management URL: `<mgmt>/oauth2/{device/code,token}`).

## Requirements

- bb with a compatible plugin SDK (>= 0.4.22)
- npm on the install machine (only needed if bb rebuilds the app bundle;
  a prebuilt `dist/` ships in this zip and is used when present)

## Install

```sh
unzip bb-plugin-netbird-0.1.0.zip
cd bb-plugin-netbird
npm install          # skip if a prebuilt dist/ is already present
bb plugin install .
bb plugin config netbird set managementUrl https://netbird.clush.net
```

Verify: `bb plugin list | grep netbird` and `bb netbird status`.

## Notes

- `bb netbird up` waits for a *human* to approve the device code in a
  browser (10-minute flow timeout). The sidebar page and CLI both print
  the login URL and code.
- `bb netbird down` disconnects; the daemon keeps its registration, so a
  later `up` reconnects without a new approval unless the session expired.
