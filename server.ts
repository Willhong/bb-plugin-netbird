// bb-plugin-netbird — backend entry.
//
// Brings this machine onto the self-hosted NetBird mesh with the OAuth
// device-code flow and reports live connection state.
//
// One piece of state serves three surfaces: the NetBird page in the sidebar
// (app.tsx, over RPC + realtime), the `bb netbird` CLI command, and the skill
// in skills/netbird/SKILL.md.

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

// ── wire types ────────────────────────────────────────────────────────────

const endpointSchema = z.object({
  url: z.string().nullable(),
  connected: z.boolean(),
  error: z.string().nullable(),
});

const peerInfoSchema = z.object({
  fqdn: z.string(),
  netbirdIp: z.string().nullable(),
  status: z.string(),
  connectionType: z.string().nullable(),
  latencyMs: z.number().nullable(),
  lastHandshake: z.string().nullable(),
});

export const statusSummarySchema = z.object({
  connected: z.boolean(),
  daemonStatus: z.string().nullable(),
  fqdn: z.string().nullable(),
  netbirdIp: z.string().nullable(),
  management: endpointSchema,
  signal: endpointSchema,
  relays: z.object({ total: z.number(), available: z.number() }),
  peers: z.object({
    total: z.number(),
    connected: z.number(),
    details: z.array(peerInfoSchema),
  }),
});
export type StatusSummary = z.infer<typeof statusSummarySchema>;

type UpPhase = "idle" | "starting" | "waiting-approval" | "connecting" | "error";
const UP_PHASES: readonly UpPhase[] = [
  "idle",
  "starting",
  "waiting-approval",
  "connecting",
  "error",
];

const upStateSchema = z.object({
  phase: z.enum(UP_PHASES),
  deviceUrl: z.string().nullable(),
  userCode: z.string().nullable(),
  message: z.string().nullable(),
  startedAt: z.string().nullable(),
});
export type UpState = z.infer<typeof upStateSchema>;

const stateSchema = z.object({
  up: upStateSchema,
  status: statusSummarySchema.nullable(),
  error: z.string().nullable(),
});
export type NetbirdState = z.infer<typeof stateSchema>;

export const rpcContract = defineRpcContract({
  state: {
    input: z.null(),
    output: stateSchema,
  },
  up: {
    input: z.null(),
    output: upStateSchema,
  },
  down: {
    input: z.null(),
    output: z.object({ ok: z.boolean(), message: z.string().nullable() }),
  },
});

// ── helpers ───────────────────────────────────────────────────────────────

const STATE_CHANNEL = "netbird-state";
const UP_TIMEOUT_MS = 10 * 60 * 1000;

const tail = (text: string, n = 4000) => (text.length > n ? `…${text.slice(-n)}` : text);

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

type OutputChild = ChildProcessByStdio<null, Readable, Readable>;

/** Run a short-lived CLI command; never throws, resolves on spawn error too. */
function runCli(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<CliResult> {
  return new Promise((resolve) => {
    let child: OutputChild;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: (err as Error).message });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}`.trim() });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Parse `netbird status -j` into the compact summary the UI and CLI show. */
function summarize(raw: unknown): StatusSummary {
  const r = (raw ?? {}) as Record<string, any>;
  const mgmt = (r.management ?? {}) as Record<string, any>;
  const signal = (r.signal ?? {}) as Record<string, any>;
  const relays = (r.relays ?? {}) as Record<string, any>;
  const peers = (r.peers ?? {}) as Record<string, any>;
  const details = Array.isArray(peers.details) ? peers.details : [];
  return {
    connected: mgmt.connected === true,
    daemonStatus: typeof r.daemonStatus === "string" ? r.daemonStatus : null,
    fqdn: typeof r.fqdn === "string" && r.fqdn !== "" ? r.fqdn : null,
    netbirdIp: typeof r.netbirdIp === "string" ? r.netbirdIp : null,
    management: {
      url: typeof mgmt.url === "string" ? mgmt.url : null,
      connected: mgmt.connected === true,
      error: typeof mgmt.error === "string" && mgmt.error !== "" ? mgmt.error : null,
    },
    signal: {
      url: typeof signal.url === "string" ? signal.url : null,
      connected: signal.connected === true,
      error: typeof signal.error === "string" && signal.error !== "" ? signal.error : null,
    },
    relays: {
      total: typeof relays.total === "number" ? relays.total : 0,
      available: typeof relays.available === "number" ? relays.available : 0,
    },
    peers: {
      total: typeof peers.total === "number" ? peers.total : 0,
      connected: typeof peers.connected === "number" ? peers.connected : 0,
      details: details.map((p: any) => ({
        fqdn: typeof p?.fqdn === "string" ? p.fqdn : "?",
        netbirdIp: typeof p?.netbirdIp === "string" ? p.netbirdIp : null,
        status: typeof p?.status === "string" ? p.status : "?",
        connectionType:
          typeof p?.connectionType === "string" ? p.connectionType : null,
        // netbird reports nanoseconds
        latencyMs:
          typeof p?.latency === "number"
            ? Math.round((p.latency / 1_000_000) * 10) / 10
            : null,
        lastHandshake:
          typeof p?.lastWireguardHandshake === "string"
            ? p.lastWireguardHandshake
            : null,
      })),
    },
  };
}

// ── plugin factory ────────────────────────────────────────────────────────

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    managementUrl: {
      type: "string",
      label: "Management URL",
      default: "https://netbird.clush.net",
    },
    netbirdBin: {
      type: "string",
      label: "netbird binary",
      default: "netbird",
    },
  });

  async function bin(): Promise<string> {
    const { netbirdBin } = await settings.get();
    return netbirdBin.trim() || "netbird";
  }
  async function managementUrl(): Promise<string> {
    const { managementUrl } = await settings.get();
    const url = managementUrl.trim();
    if (!url) throw new Error("Set the management URL (bb plugin config netbird set managementUrl ...)");
    return url;
  }

  async function fetchStatus(): Promise<StatusSummary> {
    const { code, stdout, stderr } = await runCli(await bin(), ["status", "-j"], 10_000);
    if (code !== 0) {
      throw new Error(
        `netbird status failed (exit ${code ?? "spawn"}): ${tail(stderr || stdout, 500)}`,
      );
    }
    return summarize(JSON.parse(stdout));
  }

  // In-memory state for the `netbird up` process. The process only lives as
  // long as the user takes to approve the device code; daemon state
  // (fetchStatus) is the source of truth for connectivity either way.
  const up = {
    child: null as OutputChild | null,
    state: {
      phase: "idle",
      deviceUrl: null,
      userCode: null,
      message: null,
      startedAt: null,
    } as UpState,
    buffer: "",
    timer: null as NodeJS.Timeout | null,
  };

  function publishState(): void {
    bb.realtime.publish(STATE_CHANNEL, { up: up.state });
  }
  function setPhase(patch: Partial<UpState>): void {
    up.state = { ...up.state, ...patch };
    publishState();
  }
  function releaseUp(): void {
    if (up.timer) {
      clearTimeout(up.timer);
      up.timer = null;
    }
    up.child = null;
    up.buffer = "";
  }

  async function startUp(): Promise<UpState> {
    if (up.child) return up.state; // one flow at a time
    const mgmt = await managementUrl();
    const child = spawn(
      await bin(),
      [
        "up",
        "-m",
        mgmt,
        "--admin-url",
        mgmt,
        "--no-browser",
        "--log-file",
        "console",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    up.child = child;
    up.buffer = "";
    setPhase({
      phase: "starting",
      deviceUrl: null,
      userCode: null,
      message: null,
      startedAt: new Date().toISOString(),
    });

    const onData = (chunk: Buffer) => {
      up.buffer += chunk.toString();
      if (!up.state.deviceUrl) {
        // Stock NetBird on macOS emits a PKCE URL (`/oauth2/auth`) while
        // device-flow builds emit `/oauth2/device?...user_code=...`. Capture
        // either and let the BB frontend open it in the user's browser.
        const url =
          up.buffer.match(/Use this URL to log in:\s*(https?:\/\/[^\s\x1b]+)/i) ??
          up.buffer.match(/(https?:\/\/[^\s\x1b]+\/oauth2\/(?:auth|device)\?[^\s\x1b]+)/i);
        if (url) {
          const code = up.buffer.match(/user_code=([A-Z0-9][A-Z0-9-]{3,})/);
          setPhase({
            phase: "waiting-approval",
            deviceUrl: url[1],
            userCode: code?.[1] ?? null,
          });
        }
      } else if (up.state.phase === "waiting-approval" && /Connected/.test(up.buffer)) {
        setPhase({ phase: "connecting" });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    up.timer = setTimeout(() => {
      if (up.child === child) {
        child.kill("SIGTERM");
        setPhase({ phase: "error", message: "device approval timed out after 10 minutes" });
      }
    }, UP_TIMEOUT_MS);

    child.on("error", (err) => {
      if (up.child !== child) return;
      releaseUp();
      setPhase({
        phase: "error",
        message: `failed to start netbird: ${err.message}`,
      });
    });
    child.on("close", (code) => {
      if (up.child !== child) return;
      const out = up.buffer;
      releaseUp();
      if (code === 0) {
        setPhase({
          phase: "idle",
          message: up.state.phase === "connecting" ? null : "netbird up finished",
        });
      } else {
        setPhase({
          phase: "error",
          message: `netbird up exited with code ${code}: ${tail(out, 400)}`,
        });
      }
    });

    return up.state;
  }

  async function stop(): Promise<{ ok: boolean; message: string | null }> {
    if (up.child) {
      up.child.kill("SIGTERM");
    }
    const { code, stdout, stderr } = await runCli(await bin(), ["down"], 15_000);
    if (code === 0) return { ok: true, message: null };
    return {
      ok: false,
      message: `netbird down failed (exit ${code ?? "spawn"}): ${tail(stderr || stdout, 400)}`,
    };
  }

  // ── RPC (sidebar page) ─────────────────────────────────────────────────
  bb.rpc.register(rpcContract, {
    state: async () => {
      let status: StatusSummary | null = null;
      let error: string | null = null;
      try {
        status = await fetchStatus();
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      return { up: up.state, status, error };
    },
    up: async () => startUp(),
    down: async () => stop(),
  });

  // ── CLI (agents + users) ───────────────────────────────────────────────
  const usage = [
    "Usage:",
    "  bb netbird status [--json]    show connection status",
    "  bb netbird up [--wait]        connect via device-code flow",
    "  bb netbird down               disconnect",
  ].join("\n");

  function formatStatus(s: StatusSummary): string {
    const lines: string[] = [];
    lines.push(`NetBird: ${s.connected ? "CONNECTED" : "disconnected"}`);
    if (s.fqdn) lines.push(`  FQDN:       ${s.fqdn}`);
    if (s.netbirdIp) lines.push(`  IP:         ${s.netbirdIp}`);
    if (s.management.url)
      lines.push(`  Management: ${s.management.url} (${s.management.connected ? "connected" : s.management.error || "disconnected"})`);
    if (s.signal.url)
      lines.push(`  Signal:     ${s.signal.url} (${s.signal.connected ? "connected" : s.signal.error || "disconnected"})`);
    lines.push(`  Relays:     ${s.relays.available}/${s.relays.total} available`);
    lines.push(`  Peers:      ${s.peers.connected}/${s.peers.total} connected`);
    for (const peer of s.peers.details) {
      const latency = peer.latencyMs != null ? `  ${peer.latencyMs}ms` : "";
      const type = peer.connectionType ? `  ${peer.connectionType}` : "";
      lines.push(
        `    ${peer.status.padEnd(11)}${type}${latency}  ${peer.netbirdIp ?? "?"}  ${peer.fqdn}`,
      );
    }
    return lines.join("\n");
  }

  function formatUpState(state: UpState): string {
    switch (state.phase) {
      case "waiting-approval":
        return [
          "Device-code flow started — waiting for approval.",
          "Open this URL in a browser and enter the code:",
          `  ${state.deviceUrl}`,
          `  user code: ${state.userCode ?? "?"}`,
        ].join("\n");
      case "starting":
        return "Device-code flow starting — the login URL will appear in a few seconds (re-run `bb netbird status` or wait and re-run `bb netbird up`).";
      case "connecting":
        return "Approved — connecting to the mesh…";
      case "error":
        return `Device-code flow failed: ${state.message ?? "unknown error"}`;
      case "idle":
        return "No device-code flow running.";
    }
  }

  bb.cli.register({
    name: "netbird",
    summary: "Self-hosted NetBird mesh: device-code connect, status, disconnect",
    commands: [
      { name: "status", summary: "Show connection status", usage: "bb netbird status [--json]" },
      {
        name: "up",
        summary: "Connect via device-code flow (prints the login URL + user code)",
        usage: "bb netbird up [--wait]",
      },
      { name: "down", summary: "Disconnect from the mesh", usage: "bb netbird down" },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const wait = argv.includes("--wait");
      const [command, ...args] = argv.filter((a) => !a.startsWith("--"));
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };
        case "status": {
          if (args.length > 0) break;
          try {
            const s = await fetchStatus();
            const state = { up: up.state, status: s, error: null };
            return json
              ? { exitCode: 0, stdout: JSON.stringify(state, null, 2) }
              : {
                  exitCode: 0,
                  stdout: `${formatStatus(s)}\n\n${formatUpState(up.state)}`,
                };
          } catch (err) {
            return {
              exitCode: 1,
              stderr: err instanceof Error ? err.message : String(err),
            };
          }
        }
        case "up": {
          if (args.length > 0) break;
          await startUp();
          if (wait) {
            // Block until the flow settles (approval, success, or failure).
            const deadline = Date.now() + UP_TIMEOUT_MS;
            while (up.child && Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 2000));
            }
          } else {
            // Give the CLI a moment to print the URL before we answer.
            for (let i = 0; i < 25 && !up.state.deviceUrl && up.child; i++) {
              await new Promise((r) => setTimeout(r, 500));
            }
          }
          let currentStatus: StatusSummary | null;
          try {
            currentStatus = await fetchStatus();
          } catch {
            currentStatus = null;
          }
          const text = [
            currentStatus ? formatStatus(currentStatus) : "NetBird: status unavailable",
            "",
            formatUpState(up.state),
          ].join("\n");
          const failed = up.state.phase === "error";
          return json
            ? { exitCode: failed ? 1 : 0, stdout: JSON.stringify({ up: up.state }, null, 2) }
            : { exitCode: failed ? 1 : 0, stdout: text };
        }
        case "down": {
          if (args.length > 0) break;
          const result = await stop();
          return json
            ? { exitCode: result.ok ? 0 : 1, stdout: JSON.stringify(result) }
            : {
                exitCode: result.ok ? 0 : 1,
                stdout: result.ok ? "Disconnected from the NetBird mesh." : "",
                stderr: result.message ?? undefined,
              };
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  bb.onDispose(() => {
    if (up.child) up.child.kill("SIGTERM");
    if (up.timer) clearTimeout(up.timer);
    bb.log.info("disposed");
  });
}
