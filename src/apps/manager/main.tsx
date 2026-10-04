import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { KioskStatus, Ride, Rider } from "../../types";
import type { RideMetrics } from "../../types";
import "../../styles.css";

function ManagerApp() {
  const [status, setStatus] = useState<KioskStatus | null>(null);
  const [riders, setRiders] = useState<Rider[]>([]);
  const [rides, setRides] = useState<Ride[]>([]);
  const [metrics, setMetrics] = useState<RideMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyRiderId, setBusyRiderId] = useState<number | null>(null);
  const [lockMessage, setLockMessage] = useState("Please ask staff to unlock this kiosk.");

  const refresh = useCallback(async () => {
    const [nextStatus, nextRiders, nextRides, latestMetrics] = await Promise.all([
      invoke<KioskStatus>("get_kiosk_status"),
      invoke<Rider[]>("list_riders"),
      invoke<Ride[]>("list_rides", { limit: 20 }),
      invoke<RideMetrics | null>("get_latest_metrics"),
    ]);
    setStatus(nextStatus);
    setRiders(nextRiders);
    setRides(nextRides);
    setMetrics(latestMetrics);
  }, []);

  useEffect(() => {
    if (!isTauri()) {
      setError("Open the Manager Console from the WorkFit kiosk app to access local management.");
      return;
    }
    let mounted = true;
    const unlisteners: (() => void)[] = [];
    refresh().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    const subscribe = async () => {
      const stopMetrics = await listen<RideMetrics>("ride-metrics", (event) => setMetrics(event.payload));
      const stopStart = await listen("ride-started", () => {
        if (mounted) void refresh().catch((reason: unknown) => setError(String(reason)));
      });
      const stopEnd = await listen("ride-ended", () => {
        setMetrics(null);
        if (mounted) void refresh().catch((reason: unknown) => setError(String(reason)));
      });
      [stopMetrics, stopStart, stopEnd].forEach((stop) => {
        if (mounted) unlisteners.push(stop);
        else stop();
      });
    };
    subscribe().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    const poll = window.setInterval(() => {
      if (mounted) refresh().catch((reason: unknown) => setError(String(reason)));
    }, 2000);
    return () => {
      mounted = false;
      window.clearInterval(poll);
      unlisteners.forEach((stop) => stop());
    };
  }, [refresh]);

  const toggleRiderLock = async (rider: Rider) => {
    setBusyRiderId(rider.id);
    setError(null);
    setNotice(null);
    try {
      await invoke("set_rider_locked", { riderId: rider.id, locked: !rider.locked });
      await refresh();
      setNotice(`${rider.name} ${rider.locked ? "unlocked" : "locked"}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusyRiderId(null);
    }
  };

  const setKioskLock = async (locked: boolean) => {
    setError(null);
    setNotice(null);
    try {
      await invoke("set_kiosk_lock", { message: locked ? lockMessage : null });
      await refresh();
      setNotice(locked ? "Kiosk locked." : "Kiosk unlocked.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <main className="shell">
      <div className="content">
        <div className="eyebrow">WorkFit · Local administration</div>
        <h1 className="mt-3 text-5xl font-black">Manager Console</h1>
        <p className="muted mt-4 max-w-3xl text-lg">
          This console manages the local kiosk database. It is not remotely accessible; network administration is disabled until secure device pairing is provisioned.
        </p>
        {error && <p className="mt-5 rounded-xl border border-rose-500/40 p-4 text-rose-200" role="alert">{error}</p>}
        {notice && <p className="mt-5 rounded-xl border border-lime-500/40 p-4 text-lime-200" role="status">{notice}</p>}

        <section className="mt-8 grid gap-5 md:grid-cols-3">
          <StatusPanel title="Kiosk" value={status ? "Running" : "Checking…"} />
          <StatusPanel title="Connected displays" value={status ? String(status.displays.length) : "—"} />
          <StatusPanel title="Active ride" value={status?.activeRide ? "In progress" : "None"} />
        </section>
        {metrics && (
          <section className="panel mt-5">
            <div className="eyebrow">Live read-only telemetry</div>
            <div className="mt-3 flex flex-wrap gap-x-8 gap-y-3 text-xl font-bold">
              <span className="accent">{metrics.power} W</span>
              <span>{metrics.cadence} RPM</span>
              <span>{metrics.speedKph.toFixed(1)} km/h</span>
              <span className="heart">{metrics.heartRate} BPM</span>
            </div>
          </section>
        )}

        <section className="panel mt-5">
          <div className="eyebrow">Local kiosk access</div>
          <p className="muted mt-3">
            {status?.lockMessage ? `Locked: ${status.lockMessage}` : "Kiosk is currently unlocked."}
          </p>
          {status?.lockMessage ? (
            <button className="mt-4 bg-lime-800" onClick={() => void setKioskLock(false)}>Unlock kiosk</button>
          ) : (
            <div className="mt-4 flex flex-wrap gap-3">
              <input
                className="min-h-14 min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-4 text-white"
                maxLength={240}
                value={lockMessage}
                onChange={(event) => setLockMessage(event.target.value)}
              />
              <button className="bg-rose-800" onClick={() => void setKioskLock(true)}>Lock kiosk</button>
            </div>
          )}
        </section>

        <section className="panel mt-5">
          <div className="eyebrow">Rider access</div>
          {riders.length === 0 ? <p className="muted mt-3">No rider profiles have been created.</p> : (
            <ul className="mt-4 divide-y divide-slate-800">
              {riders.map((rider) => (
                <li className="flex flex-wrap items-center justify-between gap-3 py-3" key={rider.id}>
                  <div>
                    <div className="font-bold">{rider.name}</div>
                    <div className="muted text-sm">{rider.locked ? "Locked from new rides" : "Ride access enabled"}</div>
                  </div>
                  <button
                    className={rider.locked ? "bg-lime-800" : "bg-rose-800"}
                    disabled={busyRiderId === rider.id}
                    onClick={() => void toggleRiderLock(rider)}
                  >
                    {busyRiderId === rider.id ? "Saving…" : rider.locked ? "Unlock rider" : "Lock rider"}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel mt-5">
          <div className="eyebrow">Recent sessions</div>
          {rides.length === 0 ? <p className="muted mt-3">No sessions recorded.</p> : (
            <div className="mt-4 space-y-3">
              {rides.map((ride) => (
                <div className="flex flex-wrap justify-between gap-3 border-b border-slate-800 pb-3" key={ride.id}>
                  <span>{ride.riderName} · {ride.status} · {ride.source}</span>
                  <span className="muted">{ride.distanceKm.toFixed(2)} km · {Math.round(ride.averagePower)} W avg</span>
                </div>
              ))}
            </div>
          )}
        </section>
        <p className="muted mt-5 text-sm">Host shutdown, remote kiosk locking, user force-login and remote networking are not available.</p>
      </div>
    </main>
  );
}

function StatusPanel({ title, value }: { title: string; value: string }) {
  return (
    <div className="panel">
      <div className="eyebrow">{title}</div>
      <div className="mt-3 text-2xl font-bold">{value}</div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<ManagerApp />);
