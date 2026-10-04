import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { RideMetrics } from "../../types";
import "../../styles.css";

function RideDisplay() {
  const [message, setMessage] = useState("Tap the primary screen to start your ride");
  const [metrics, setMetrics] = useState<RideMetrics | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let mounted = true;
    const unlisteners: (() => void)[] = [];
    invoke<string>("get_idle_message")
      .then((idleMessage) => {
        if (mounted) setMessage(idleMessage);
      })
      .catch((reason: unknown) => console.error("Unable to load the idle message:", reason));
    const subscribe = async () => {
      const stopIdle = await listen<string>("idle-message-updated", (event) => setMessage(event.payload));
      const stopStart = await listen<number>("ride-started", () => setMetrics({
        power: 0, cadence: 0, speedKph: 0, heartRate: 0, grade: 0, elapsedSeconds: 0,
      }));
      const stopMetrics = await listen<RideMetrics>("ride-metrics", (event) => setMetrics(event.payload));
      const stopEnd = await listen("ride-ended", () => setMetrics(null));
      [stopIdle, stopStart, stopMetrics, stopEnd].forEach((stop) => {
        if (mounted) unlisteners.push(stop);
        else stop();
      });
    };
    subscribe().catch((reason: unknown) => console.error("Unable to subscribe to ride display updates:", reason));
    return () => {
      mounted = false;
      unlisteners.forEach((stop) => stop());
    };
  }, []);

  return (
    <main className="shell grid min-h-screen place-items-center text-center">
      <div className="content">
        <div className="eyebrow">WorkFit · Ride display</div>
        {metrics ? (
          <>
            <h1 className="mt-6 text-4xl font-black tracking-tight sm:text-6xl">Ride in progress · demo metrics</h1>
            <section className="mt-12 grid grid-cols-2 gap-5 md:grid-cols-4">
              <DisplayMetric label="Power" value={metrics.power} unit="W" accent="accent" />
              <DisplayMetric label="Cadence" value={metrics.cadence} unit="RPM" />
              <DisplayMetric label="Speed" value={metrics.speedKph.toFixed(1)} unit="km/h" />
              <DisplayMetric label="Heart rate" value={metrics.heartRate} unit="BPM" accent="heart" />
            </section>
            <p className="muted mt-8 text-xl">Grade {metrics.grade.toFixed(1)}% · {Math.floor(metrics.elapsedSeconds / 60)}:{String(metrics.elapsedSeconds % 60).padStart(2, "0")} elapsed</p>
          </>
        ) : (
          <>
            <h1 className="mt-6 text-5xl font-black tracking-tight sm:text-8xl">Ready when you are.</h1>
            <p className="muted mx-auto mt-6 max-w-3xl text-2xl sm:text-4xl">{message}</p>
            <div className="mt-14 inline-flex items-center rounded-full border border-amber-500/40 px-5 py-3 text-amber-300">
              <span className="status-dot" />
              Waiting for ride telemetry
            </div>
          </>
        )}
      </div>
    </main>
  );
}

function DisplayMetric({ label, value, unit, accent }: { label: string; value: string | number; unit: string; accent?: string }) {
  return (
    <div className="panel">
      <div className="muted text-sm font-semibold uppercase tracking-widest">{label}</div>
      <div className={`mt-3 text-5xl font-black sm:text-7xl ${accent ?? ""}`}>{value}</div>
      <div className="muted mt-1 text-lg">{unit}</div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<RideDisplay />);
