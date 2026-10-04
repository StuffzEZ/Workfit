import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { RideMetrics } from "../../types";
import "../../styles.css";

function VRApp() {
  const [metrics, setMetrics] = useState<RideMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) {
      setError("Open the VR companion from WorkFit to receive local, read-only telemetry.");
      return;
    }
    let mounted = true;
    let unlisten: (() => void) | undefined;
    invoke<RideMetrics | null>("get_latest_metrics")
      .then((latest) => {
        if (mounted) setMetrics(latest);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    listen<RideMetrics>("ride-metrics", (event) => setMetrics(event.payload))
      .then((stop) => {
        if (mounted) unlisten = stop;
        else stop();
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    listen("ride-ended", () => setMetrics(null))
      .then((stop) => {
        if (mounted) {
          const previous = unlisten;
          unlisten = () => { previous?.(); stop(); };
        } else stop();
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, []);

  return (
    <main className="shell grid min-h-screen place-items-center text-center">
      <section className="content">
        <div className="eyebrow">WorkFit · Read-only VR telemetry</div>
        <h1 className="mt-4 text-5xl font-black">{metrics ? "Ride telemetry" : "Waiting for a ride"}</h1>
        <p className="muted mx-auto mt-5 max-w-2xl text-xl">
          This companion can read workout metrics only. It cannot change riders, control the kiosk, or issue host commands.
        </p>
        {error && <p className="mt-5 text-rose-300" role="alert">{error}</p>}
        {metrics && (
          <div className="mt-10 grid grid-cols-2 gap-4 md:grid-cols-4">
            <Metric label="Power" value={`${metrics.power} W`} accent="accent" />
            <Metric label="Cadence" value={`${metrics.cadence} RPM`} />
            <Metric label="Speed" value={`${metrics.speedKph.toFixed(1)} km/h`} />
            <Metric label="Heart rate" value={`${metrics.heartRate} BPM`} accent="heart" />
          </div>
        )}
      </section>
    </main>
  );
}

function Metric({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="panel">
      <div className="muted text-sm uppercase tracking-widest">{label}</div>
      <div className={`mt-3 text-3xl font-black sm:text-5xl ${accent ?? ""}`}>{value}</div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<VRApp />);
