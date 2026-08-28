// bb-plugin-netbird — frontend entry.
//
// A single sidebar page: live mesh status, device-code connect, disconnect.
// Compiled by `bb plugin build` into dist/app.js + dist/app.css; React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time.

import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { NetbirdState, rpcContract, StatusSummary } from "./server";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

interface ViewState {
  up: NetbirdState["up"];
  status: StatusSummary | null;
  error: string | null;
}

function useNetbird(rpc: Rpc) {
  const [view, setView] = useState<ViewState | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refetch = useCallback(() => {
    let cancelled = false;
    setRefreshing(true);
    rpc
      .call("state")
      .then((result) => {
        if (!cancelled) setView(result);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setView({
            up: {
              phase: "idle",
              deviceUrl: null,
              userCode: null,
              message: null,
              startedAt: null,
            },
            status: null,
            error: err instanceof Error ? err.message : String(err),
          });
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  useEffect(() => refetch(), [refetch]);
  // server.ts publishes on every device-flow state change (URL appeared,
  // approved, finished, failed) — from this page, `bb netbird up`, or an agent.
  useRealtime("netbird-state", useCallback(() => refetch(), [refetch]));

  return { view, refreshing, refetch };
}

function PhaseDot({ view }: { view: ViewState }) {
  const { up, status } = view;
  let color = "bg-zinc-400";
  let label = "Disconnected";
  let pulse = false;
  if (up.phase === "waiting-approval" || up.phase === "starting") {
    color = "bg-amber-500";
    label = up.phase === "starting" ? "Starting device login…" : "Waiting for approval";
    pulse = true;
  } else if (up.phase === "connecting") {
    color = "bg-sky-500";
    label = "Connecting…";
    pulse = true;
  } else if (up.phase === "error") {
    color = "bg-red-500";
    label = "Error";
  } else if (status?.connected) {
    color = "bg-emerald-500";
    label = "Connected";
  }
  return (
    <span className="flex items-center gap-2">
      <span className={cn("size-2.5 rounded-full", color, pulse && "animate-pulse")} />
      <span className="text-sm font-semibold">{label}</span>
    </span>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-xs">{value}</span>
    </div>
  );
}

function DeviceCard({ view }: { view: ViewState }) {
  const { deviceUrl, userCode } = view.up;
  if (!deviceUrl) return null;
  return (
    <Card className="border-amber-500/40">
      <CardHeader>
        <CardTitle className="text-sm">Device code approval needed</CardTitle>
        <CardDescription>
          Open the login page, sign in, and enter this code:
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {userCode && (
          <div className="select-all font-mono text-2xl font-bold tracking-[0.3em]">
            {userCode}
          </div>
        )}
        <a
          href={deviceUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Open login page
          <Icon name="ExternalLink" className="size-4" />
        </a>
        <p className="break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
          {deviceUrl}
        </p>
      </CardContent>
    </Card>
  );
}

function ErrorCard({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <Card className="border-red-500/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm text-red-500">
          <Icon name="AlertCircle" className="size-4" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">
          {message}
        </pre>
      </CardContent>
    </Card>
  );
}

function PeerList({ status }: { status: StatusSummary }) {
  if (status.peers.details.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">
          Peers ({status.peers.connected}/{status.peers.total} connected)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {status.peers.details.map((peer) => (
            <li key={peer.fqdn} className="flex items-center gap-3 py-2 text-sm">
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  peer.status === "Connected" ? "bg-emerald-500" : "bg-zinc-400",
                )}
              />
              <span className="min-w-0 flex-1 truncate" title={peer.fqdn}>
                {peer.fqdn}
              </span>
              <span className="hidden font-mono text-xs text-muted-foreground sm:inline">
                {peer.netbirdIp}
              </span>
              <span className="w-14 text-right font-mono text-xs text-muted-foreground">
                {peer.latencyMs != null ? `${peer.latencyMs}ms` : "—"}
              </span>
              <span className="w-12 text-right text-xs text-muted-foreground">
                {peer.connectionType ?? "—"}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function NetbirdPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const { view, refreshing, refetch } = useNetbird(rpc);
  const [busy, setBusy] = useState(false);

  const act = useCallback(
    async (method: "up" | "down") => {
      setBusy(true);
      try {
        if (method === "up") await rpc.call("up");
        else await rpc.call("down");
        refetch();
      } catch (err) {
        // The state RPC surfaces the failure; a toast keeps the click honest.
        // eslint-disable-next-line no-console
        console.error("netbird action failed", err);
      } finally {
        setBusy(false);
      }
    },
    [rpc, refetch],
  );

  if (!view) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Icon name="Loading" className="mr-2 size-4 animate-spin" />
        Loading…
      </div>
    );
  }

  const { up, status, error } = view;
  const busyFlow =
    up.phase === "starting" || up.phase === "waiting-approval" || up.phase === "connecting";

  return (
    <div className="flex min-h-full flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <PhaseDot view={view} />
        <div className="flex items-center gap-1.5">
          {status?.fqdn && (
            <span className="hidden max-w-52 truncate font-mono text-xs text-muted-foreground md:inline">
              {status.fqdn}
            </span>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground hover:text-foreground"
            aria-label="Refresh status"
            disabled={refreshing || busy}
            onClick={refetch}
          >
            <Icon name="Repeat" className={cn("size-4", refreshing && "animate-spin")} />
          </Button>
        </div>
      </div>

      {busyFlow && <DeviceCard view={view} />}

      {up.phase === "error" && (
        <ErrorCard title="Device-code flow failed" message={up.message ?? "unknown error"} />
      )}
      {error && !up.message && (
        <ErrorCard title="Status unavailable" message={error} />
      )}

      {status && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Connection</CardTitle>
          </CardHeader>
          <CardContent>
            <DetailRow
              label="Management"
              value={
                status.management.connected
                  ? "connected"
                  : (status.management.error ?? "disconnected")
              }
            />
            <DetailRow
              label="Signal"
              value={
                status.signal.connected
                  ? "connected"
                  : (status.signal.error ?? "disconnected")
              }
            />
            <DetailRow
              label="Relays"
              value={`${status.relays.available}/${status.relays.total} available`}
            />
            {status.netbirdIp && <DetailRow label="Mesh IP" value={status.netbirdIp} />}
            <DetailRow
              label="Daemon"
              value={status.daemonStatus ?? "unknown"}
            />
          </CardContent>
        </Card>
      )}

      {status && <PeerList status={status} />}

      <div className="mt-auto flex items-center gap-2 border-t pt-4">
        {status?.connected ? (
          <Button variant="outline" disabled={busy} onClick={() => void act("down")}>
            <Icon name="CloudOff" className="mr-2 size-4" />
            Disconnect
          </Button>
        ) : (
          <Button disabled={busy || busyFlow} onClick={() => void act("up")}>
            <Icon name="ElectricPlugs" className="mr-2 size-4" />
            {busyFlow ? "Waiting…" : "Connect (device code)"}
          </Button>
        )}
        {busyFlow && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void act("down")}
            className="text-muted-foreground"
          >
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "netbird",
    title: "NetBird",
    icon: "Globe",
    path: "netbird",
    component: NetbirdPanel,
  });
});
