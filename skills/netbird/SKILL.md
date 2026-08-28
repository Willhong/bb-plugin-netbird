---
name: netbird
description: Connect this machine to the self-hosted NetBird mesh and inspect connectivity. Use when the user asks to connect/disconnect the NetBird mesh, check mesh status or peers, or reach a machine only on the mesh.
---

# NetBird

The plugin drives the local `netbird` CLI. The mesh is self-hosted
(management URL is a plugin setting, default `https://netbird.clush.net`).

## Commands

| Command | Effect |
| --- | --- |
| `bb netbird status` | Connection status: daemon, management, signal, relays, peers. `--json` for structured output. |
| `bb netbird up` | Start the device-code flow and print the login URL + user code. `--wait` blocks until the flow settles. |
| `bb netbird down` | Disconnect from the mesh. |

## Device-code connect procedure

1. Run `bb netbird up`. It prints a login URL and a user code.
2. Hand **both** to the user — a human must open the URL, sign in via SSO,
   and enter the code. You cannot approve it yourself.
3. Poll `bb netbird status` (every ~10–15 s) until it reports CONNECTED or
   the flow reports an error.

## Notes

- If status says `management ... disconnected`, the daemon is down or not
  registered; `bb netbird up` re-registers/authenticates.
- The device flow expires after 10 minutes; start a fresh one with
  `bb netbird up` again.
- Prefer `--json` when the output drives further commands.
