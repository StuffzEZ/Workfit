import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { RouteStudio } from "./RouteStudio";
import { BUILT_IN_CATALOG_VERSION, builtInRoutes } from "./routeCatalog";
import type {
  BluetoothHeartRateDevice,
  BluetoothHeartRateConnection,
  BluetoothHeartRateSample,
  KioskStatus,
  LeaderboardEntry,
  RaceSession,
  Ride,
  RideMetrics,
  Rider,
  Route,
  RoutePoint,
} from "../../types";
import "../../styles.css";

type WorkoutPhase = { name: string; durationMinutes: number; intensity: number };
type WorkoutPlan = {
  name: string;
  focus: string;
  durationMinutes: number;
  color: string;
  phases: WorkoutPhase[];
};

const workoutPlans: WorkoutPlan[] = [
  { name: "Easy spin", focus: "Recovery", durationMinutes: 30, color: "#06b6d4", phases: [
    { name: "Warm up", durationMinutes: 5, intensity: 0.45 },
    { name: "Easy spin", durationMinutes: 20, intensity: 0.55 },
    { name: "Cool down", durationMinutes: 5, intensity: 0.4 },
  ] },
  { name: "Tempo builder", focus: "Endurance", durationMinutes: 40, color: "#84cc16", phases: [
    { name: "Warm up", durationMinutes: 5, intensity: 0.5 },
    { name: "Endurance", durationMinutes: 10, intensity: 0.65 },
    { name: "Tempo", durationMinutes: 15, intensity: 0.8 },
    { name: "Endurance", durationMinutes: 5, intensity: 0.65 },
    { name: "Cool down", durationMinutes: 5, intensity: 0.45 },
  ] },
  { name: "Threshold blocks", focus: "Threshold", durationMinutes: 45, color: "#f59e0b", phases: [
    { name: "Warm up", durationMinutes: 8, intensity: 0.5 },
    { name: "Build", durationMinutes: 8, intensity: 0.75 },
    { name: "Threshold", durationMinutes: 5, intensity: 0.95 },
    { name: "Recovery", durationMinutes: 4, intensity: 0.6 },
    { name: "Threshold", durationMinutes: 5, intensity: 0.95 },
    { name: "Recovery", durationMinutes: 4, intensity: 0.6 },
    { name: "Tempo", durationMinutes: 6, intensity: 0.8 },
    { name: "Cool down", durationMinutes: 5, intensity: 0.45 },
  ] },
  { name: "Anaerobic sprints", focus: "Power", durationMinutes: 30, color: "#fb7185", phases: [
    { name: "Warm up", durationMinutes: 6, intensity: 0.5 },
    { name: "Sprint", durationMinutes: 1, intensity: 0.9 },
    { name: "Recovery", durationMinutes: 4, intensity: 0.5 },
    { name: "Sprint", durationMinutes: 1, intensity: 0.95 },
    { name: "Recovery", durationMinutes: 4, intensity: 0.5 },
    { name: "Sprint", durationMinutes: 1, intensity: 1 },
    { name: "Recovery", durationMinutes: 4, intensity: 0.5 },
    { name: "Steady", durationMinutes: 5, intensity: 0.7 },
    { name: "Cool down", durationMinutes: 4, intensity: 0.45 },
  ] },
  { name: "Sweet spot", focus: "Fitness", durationMinutes: 50, color: "#a78bfa", phases: [
    { name: "Warm up", durationMinutes: 8, intensity: 0.5 },
    { name: "Sweet spot", durationMinutes: 12, intensity: 0.85 },
    { name: "Recovery", durationMinutes: 5, intensity: 0.6 },
    { name: "Sweet spot", durationMinutes: 12, intensity: 0.85 },
    { name: "Steady", durationMinutes: 8, intensity: 0.6 },
    { name: "Cool down", durationMinutes: 5, intensity: 0.45 },
  ] },
  { name: "Steady endurance", focus: "Endurance", durationMinutes: 60, color: "#38bdf8", phases: [
    { name: "Warm up", durationMinutes: 8, intensity: 0.5 },
    { name: "Endurance", durationMinutes: 20, intensity: 0.68 },
    { name: "Endurance", durationMinutes: 20, intensity: 0.72 },
    { name: "Steady", durationMinutes: 7, intensity: 0.62 },
    { name: "Cool down", durationMinutes: 5, intensity: 0.45 },
  ] },
];

function workoutPhaseAt(workout: WorkoutPlan, elapsedSeconds: number) {
  let phaseStartSeconds = 0;
  for (const phase of workout.phases) {
    const phaseDurationSeconds = phase.durationMinutes * 60;
    if (elapsedSeconds < phaseStartSeconds + phaseDurationSeconds) {
      return {
        phase,
        targetPower: Math.round(180 * phase.intensity),
        phaseRemainingSeconds: phaseStartSeconds + phaseDurationSeconds - elapsedSeconds,
      };
    }
    phaseStartSeconds += phaseDurationSeconds;
  }
  return { phase: null, targetPower: 0, phaseRemainingSeconds: 0 };
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

async function ensureBuiltInRoutes(routes: Route[]) {
  const currentVersions = new Map(routes.filter((route) => route.builtIn)
    .map((route) => [route.name, route.catalogVersion]));
  const stale = builtInRoutes.filter((route) => currentVersions.get(route.name) !== BUILT_IN_CATALOG_VERSION);
  await Promise.all(stale.map((route) => invoke<Route>("save_route", {
    name: route.name,
    points: route.points,
    catalogSlug: route.slug,
    catalogVersion: BUILT_IN_CATALOG_VERSION,
    routeId: null,
  })));
  return stale.length ? invoke<Route[]>("list_routes") : routes;
}

function routeGrade(route: Route | undefined, elapsedSeconds: number) {
  if (!route || route.points.length < 2) return 0;
  const traveledKm = elapsedSeconds * 25 / 3600;
  const pointIndex = Math.min(
    route.points.length - 2,
    Math.floor(traveledKm / route.distanceKm * (route.points.length - 1)),
  );
  const left = route.points[pointIndex];
  const right = route.points[pointIndex + 1];
  const latitudeDelta = (right.latitude - left.latitude) * Math.PI / 180;
  const longitudeDelta = (right.longitude - left.longitude) * Math.PI / 180;
  const lat1 = left.latitude * Math.PI / 180;
  const lat2 = right.latitude * Math.PI / 180;
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(longitudeDelta / 2) ** 2;
  const segmentMeters = 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return segmentMeters > 0
    ? Number(Math.max(-30, Math.min(30, (right.elevationM - left.elevationM) / segmentMeters * 100)).toFixed(1))
    : 0;
}

function ControlApp() {
  const [activeView, setActiveView] = useState("Ride");
  const [status, setStatus] = useState<KioskStatus | null>(null);
  const [riders, setRiders] = useState<Rider[]>([]);
  const [rides, setRides] = useState<Ride[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [selectedRouteId, setSelectedRouteId] = useState<number | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [selectedRiderId, setSelectedRiderId] = useState<number | null>(null);
  const [newRider, setNewRider] = useState("");
  const [activeRide, setActiveRide] = useState(false);
  const [activeWorkout, setActiveWorkout] = useState<WorkoutPlan | null>(null);
  const [activeRace, setActiveRace] = useState<RaceSession | null>(null);
  const [lockMessage, setLockMessage] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<RideMetrics>({
    power: 0, cadence: 0, speedKph: 0, heartRate: 0, grade: 0, elapsedSeconds: 0,
  });
  const [idleMessage, setIdleMessage] = useState("Tap the primary screen to start your ride");
  const [error, setError] = useState<string | null>(null);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tickerGeneration, setTickerGeneration] = useState(0);
  const [studioRoute, setStudioRoute] = useState<Route | null | false>(false);
  const [exitHint, setExitHint] = useState(false);
  const [routeSearch, setRouteSearch] = useState("");
  const [routeDifficulty, setRouteDifficulty] = useState("All routes");
  const intervalRef = useRef<number | null>(null);
  const lastSampleRef = useRef(0);
  const samplePendingRef = useRef(false);

  const refreshData = useCallback(async () => {
    const [nextRiders, nextRides, nextLeaderboard, savedRoutes] = await Promise.all([
      invoke<Rider[]>("list_riders"),
      invoke<Ride[]>("list_rides", { limit: 100 }),
      invoke<LeaderboardEntry[]>("get_leaderboard"),
      invoke<Route[]>("list_routes"),
    ]);
    const nextRoutes = await ensureBuiltInRoutes(savedRoutes);
    setRiders(nextRiders);
    setRides(nextRides);
    setLeaderboard(nextLeaderboard);
    setRoutes(nextRoutes);
    if (selectedRiderId === null) {
      setSelectedRiderId(nextRiders.find((rider) => !rider.locked)?.id ?? null);
    }
  }, [selectedRiderId]);

  const refreshStatus = useCallback(async () => {
    if (!isTauri()) return;
    setStatus(await invoke<KioskStatus>("get_kiosk_status"));
  }, []);

  useEffect(() => {
    if (!isTauri()) {
      setError("Install and launch WorkFit to use local profiles and ride history.");
      setRoutes(builtInRoutes.map((route, index) => ({
        id: -(index + 1),
        name: route.name,
        distanceKm: route.distanceKm,
        elevationGainM: route.elevationGainM,
        pointCount: route.points.length,
        points: route.points,
        builtIn: true,
        catalogVersion: BUILT_IN_CATALOG_VERSION,
      })));
      return;
    }
    let mounted = true;
    let stopLockListener: (() => void) | undefined;
    listen<string>("kiosk-lock-updated", (event) => setLockMessage(event.payload || null))
      .then((stop) => {
        if (mounted) stopLockListener = stop;
        else stop();
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    const statusPoll = window.setInterval(() => {
      invoke<KioskStatus>("get_kiosk_status")
        .then((nextStatus) => {
          if (!mounted) return;
          setStatus(nextStatus);
          setLockMessage(nextStatus.lockMessage);
        })
        .catch((reason: unknown) => {
          if (mounted) setError(reason instanceof Error ? reason.message : String(reason));
        });
    }, 2000);
    Promise.all([
      invoke<KioskStatus>("get_kiosk_status"),
      invoke<Rider[]>("list_riders"),
      invoke<Ride[]>("list_rides", { limit: 100 }),
      invoke<LeaderboardEntry[]>("get_leaderboard"),
      invoke<string>("get_idle_message"),
      invoke<Route[]>("list_routes"),
      invoke<RideMetrics | null>("get_latest_metrics"),
    ])
      .then(async ([nextStatus, nextRiders, nextRides, nextLeaderboard, nextMessage, savedRoutes, latestMetrics]) => {
        if (!mounted) return;
        setStatus(nextStatus);
        setLockMessage(nextStatus.lockMessage);
        setRiders(nextRiders);
        setRides(nextRides);
        setLeaderboard(nextLeaderboard);
        setSelectedRiderId(nextRiders.find((rider) => !rider.locked)?.id ?? null);
        setIdleMessage(nextMessage);
        setRoutes(await ensureBuiltInRoutes(savedRoutes));
        setActiveRide(nextStatus.activeRide);
        if (latestMetrics) {
          setMetrics(latestMetrics);
          lastSampleRef.current = latestMetrics.elapsedSeconds;
        }
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      mounted = false;
      stopLockListener?.();
      window.clearInterval(statusPoll);
      if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
    };
  }, []);

  const createRider = async () => {
    const name = newRider.trim();
    if (!name) return;
    setBusy(true);
    setError(null);
    try {
      const rider = await invoke<Rider>("create_rider", { name });
      setRiders((current) => [...current, rider].sort((a, b) => a.name.localeCompare(b.name)));
      setSelectedRiderId(rider.id);
      setNewRider("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (activeRace?.mode === "baseline" && metrics.elapsedSeconds >= 120 && !busy) {
      void finishRide();
    }
  }, [activeRace, busy, metrics.elapsedSeconds]);

  const startRide = async (
    routeId = selectedRouteId,
    workout: WorkoutPlan | null = null,
    race: RaceSession | null = null,
  ) => {
    if (selectedRiderId === null) return;
    setBusy(true);
    setError(null);
    try {
      await invoke<number>("start_ride", {
        riderId: selectedRiderId,
        source: "demo",
        routeId,
      });
      setMetrics({ power: 0, cadence: 0, speedKph: 0, heartRate: 0, grade: 0, elapsedSeconds: 0 });
      lastSampleRef.current = 0;
      setActiveWorkout(workout);
      setActiveRace(race);
      setActiveRide(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!activeRide || !isTauri()) return;
    intervalRef.current = window.setInterval(() => {
      if (samplePendingRef.current) return;
      samplePendingRef.current = true;
      const elapsedSeconds = lastSampleRef.current + 1;
      const wave = Math.sin(elapsedSeconds / 11);
      const workoutStage = activeWorkout ? workoutPhaseAt(activeWorkout, elapsedSeconds) : null;
      const sample: RideMetrics = {
        elapsedSeconds,
        power: workoutStage
          ? Math.round(workoutStage.targetPower * (0.96 + wave * 0.06))
          : Math.round(145 + wave * 35),
        cadence: Math.round(82 + Math.sin(elapsedSeconds / 8) * 7),
        speedKph: Number((25 + wave * 4).toFixed(1)),
        heartRate: Math.round(128 + elapsedSeconds * 0.04 + Math.sin(elapsedSeconds / 15) * 5),
        grade: selectedRouteId === null
          ? Number((Math.sin(elapsedSeconds / 25) * 2).toFixed(1))
          : routeGrade(routes.find((route) => route.id === selectedRouteId), elapsedSeconds),
      };
      invoke("record_metrics", { metrics: sample })
        .then(() => {
          lastSampleRef.current = elapsedSeconds;
          setMetrics(sample);
        })
        .catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason));
          if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
        })
        .finally(() => {
          samplePendingRef.current = false;
        });
    }, 1000);
    return () => {
      if (intervalRef.current !== null) window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    };
  }, [activeRide, activeWorkout, routes, selectedRouteId, tickerGeneration]);

  const importGpx = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("GPX files must be 10 MB or smaller.");
      const xml = new DOMParser().parseFromString(await file.text(), "application/xml");
      if (xml.querySelector("parsererror")) throw new Error("The selected file is not valid GPX/XML.");
      const trackPoints = [...xml.getElementsByTagNameNS("*", "trkpt")];
      const elements = trackPoints.length > 0
        ? trackPoints
        : [...xml.getElementsByTagNameNS("*", "rtept")];
      if (elements.length > 50_000) throw new Error("GPX routes are limited to 50,000 points.");
      if (elements.some((element) => element.getAttribute("lat") === null || element.getAttribute("lon") === null)) {
        throw new Error("Each GPX track point must have latitude and longitude.");
      }
      const points: RoutePoint[] = elements.map((element) => ({
        latitude: Number(element.getAttribute("lat")),
        longitude: Number(element.getAttribute("lon")),
        elevationM: Number(element.getElementsByTagNameNS("*", "ele")[0]?.textContent ?? 0),
      }));
      const routeName = file.name.replace(/\.gpx$/i, "").slice(0, 80);
      const saved = await invoke<Route>("save_route", {
        name: routeName || "Imported GPX",
        points,
        catalogSlug: null,
        catalogVersion: null,
        routeId: null,
      });
      setRoutes((current) => [...current, saved].sort((a, b) => a.name.localeCompare(b.name)));
      setSelectedRouteId(saved.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const finishRide = async () => {
    setBusy(true);
    setError(null);
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    try {
      while (samplePendingRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      }
      await invoke<Ride>("end_ride");
      setActiveRide(false);
      setActiveWorkout(null);
      setActiveRace(null);
      await refreshData();
      setStatus((current) => current ? { ...current, activeRide: false } : current);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setTickerGeneration((generation) => generation + 1);
    } finally {
      setBusy(false);
    }
  };

  const updateIdleMessage = (message: string) => {
    setIdleMessage(message);
    if (!isTauri() || message.trim().length === 0) return;
    invoke("set_idle_message", { message })
      .then(() => setMessageError(null))
      .catch((reason: unknown) => setMessageError(reason instanceof Error ? reason.message : String(reason)));
  };

  const exitWorkFit = async () => {
    if (isTauri()) {
      try {
        await invoke("exit_workfit");
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
      return;
    }
    window.close();
    setExitHint(true);
  };

  const saveCustomRoute = async (name: string, points: RoutePoint[], routeId?: number) => {
    const route = await invoke<Route>("save_route", {
      name,
      points,
      catalogSlug: null,
      catalogVersion: null,
      routeId: routeId ?? null,
    });
    setRoutes((current) => [...current.filter((item) => item.id !== route.id), route]
      .sort((left, right) => left.name.localeCompare(right.name)));
    setSelectedRouteId(route.id);
    setStudioRoute(false);
  };

  const startGame = (mode: RaceSession["mode"]) => {
    if (selectedRiderId === null) {
      setError("Add or select a rider before starting a race.");
      return;
    }
    const routeId = selectedRouteId ?? routes[0]?.id ?? null;
    const eligibleRides = rides.filter((ride) =>
      ride.status === "completed"
      && ride.durationSeconds > 0
      && ride.routeId === routeId);
    let referenceRides: Ride[] = [];
    if (mode === "personalBest") {
      referenceRides = eligibleRides
        .filter((ride) => ride.riderId === selectedRiderId)
        .sort((left, right) => left.durationSeconds - right.durationSeconds)
        .slice(0, 1);
      if (referenceRides.length === 0) {
        setError("Complete a ride on this route first to create your personal-best ghost.");
        return;
      }
    } else if (mode === "pastRiders") {
      const fastestRidePerRider = new Map<number, Ride>();
      eligibleRides.filter((ride) => ride.riderId !== selectedRiderId).forEach((ride) => {
        const previous = fastestRidePerRider.get(ride.riderId);
        if (!previous
          || ride.distanceKm / Math.max(1, ride.durationSeconds)
            > previous.distanceKm / Math.max(1, previous.durationSeconds)) {
          fastestRidePerRider.set(ride.riderId, ride);
        }
      });
      referenceRides = [...fastestRidePerRider.values()]
        .sort((left, right) =>
          right.distanceKm / Math.max(1, right.durationSeconds)
          - left.distanceKm / Math.max(1, left.durationSeconds))
        .slice(0, 3);
      if (referenceRides.length === 0) {
        setError("No other riders have completed this route yet. Invite someone to ride it first.");
        return;
      }
    }
    setError(null);
    setActiveView("Ride");
    void startRide(routeId, null, { mode, referenceRides });
  };

  const visibleBuiltInRoutes = builtInRoutes.filter((route) => {
    const matchesDifficulty = routeDifficulty === "All routes" || route.difficulty === routeDifficulty;
    const query = routeSearch.trim().toLocaleLowerCase();
    const matchesSearch = !query
      || `${route.name} ${route.region} ${route.country}`.toLocaleLowerCase().includes(query);
    return matchesDifficulty && matchesSearch;
  });
  const activeRoute = selectedRouteId === null ? undefined : routes.find((route) => route.id === selectedRouteId);

  return (
    <main className="app-shell">
      {lockMessage && (
        <section className="fixed inset-0 z-50 grid place-items-center bg-[#08090a] p-8 text-center" role="alert">
          <div className="max-w-3xl">
            <div className="eyebrow">WorkFit · Kiosk locked</div>
            <h1 className="mt-5 text-5xl font-black">This kiosk is unavailable</h1>
            <p className="muted mt-5 text-2xl">{lockMessage}</p>
            <p className="muted mt-8">Please ask a staff member for assistance.</p>
          </div>
        </section>
      )}
      {exitHint && (
        <section className="exit-overlay" role="alertdialog" aria-modal="true" aria-labelledby="exit-title">
          <div className="exit-card">
            <div className="eyebrow">BROWSER PREVIEW</div>
            <h1 id="exit-title">Close this tab to exit WorkFit.</h1>
            <p className="muted">Your browser does not allow this page to close a tab it did not open.</p>
            <button className="secondary-action" onClick={() => setExitHint(false)}>Back to WorkFit</button>
          </div>
        </section>
      )}
      <aside className="app-sidebar">
        <div className="brand-mark"><span className="brand-glyph">W</span><span>WORKFIT</span></div>
        <div className="sidebar-caption">TRAINING</div>
        {[
          ["Ride", "◉"], ["Routes", "⌁"], ["Games", "◌"], ["Workouts", "▥"], ["Activities", "◷"],
        ].map(([label, icon]) => (
          <button className={`nav-item ${activeView === label ? "selected" : ""}`} key={label} onClick={() => setActiveView(label)}>
            <span className="nav-icon">{icon}</span><span>{label}</span>
          </button>
        ))}
        <div className="sidebar-caption sidebar-spaced">SYSTEM</div>
        {[
          ["Devices", "⌁"], ["Settings", "⚙"],
        ].map(([label, icon]) => (
          <button className={`nav-item ${activeView === label ? "selected" : ""}`} key={label} onClick={() => setActiveView(label)}>
            <span className="nav-icon">{icon}</span><span>{label}</span>
          </button>
        ))}
        <button aria-label="Exit WorkFit" className="nav-item exit-nav-item" onClick={() => void exitWorkFit()}>
          <span className="nav-icon">↗</span><span>Exit WorkFit</span>
        </button>
        <div className="sidebar-footer">
          <span className="connection-indicator" />
          <div><strong>Local kiosk</strong><small>{status?.secondaryDisplayOpen ? "Dual display" : "Single display"}</small></div>
        </div>
      </aside>
      <div className="app-main">
        <header className="app-topbar">
          <div className="breadcrumbs">WORKFIT <span>/</span> <strong>{activeView.toUpperCase()}</strong></div>
          <div className="topbar-right">
            <span className={`equipment-pill ${activeRide ? "riding" : ""}`}><span className="status-dot" />{activeRide ? "DEMO SESSION" : "NO DEVICE CONNECTED"}</span>
            <span className="avatar-chip">{riders.find((rider) => rider.id === selectedRiderId)?.name.slice(0, 1) ?? "W"}</span>
          </div>
        </header>
        <div className="workspace">
          {error && <p className="global-error" role="alert">{error}</p>}
          {activeView === "Routes" && (
            <RoutesPage
              builtIns={visibleBuiltInRoutes}
              customRoutes={routes.filter((route) => !route.builtIn)}
              savedRoutes={routes}
              selectedRouteId={selectedRouteId}
              search={routeSearch}
              difficulty={routeDifficulty}
              onSearch={setRouteSearch}
              onDifficulty={setRouteDifficulty}
              onCreate={() => setStudioRoute(null)}
              onEdit={(route) => setStudioRoute(route)}
              onImport={(file) => void importGpx(file)}
              onSelect={(routeId) => setSelectedRouteId(routeId)}
              onStart={(routeId) => {
                setSelectedRouteId(routeId);
                setActiveView("Ride");
                if (!isTauri()) setError("Launch the Tauri desktop app to start a saved ride.");
                else if (selectedRiderId === null) setError("Add or select a rider before starting a ride.");
                else void startRide(routeId);
              }}
            />
          )}
          {activeView === "Workouts" && (
            <WorkoutsPage disabled={busy || selectedRiderId === null || !isTauri()} onStart={(workout) => {
              setActiveView("Ride");
              if (selectedRiderId === null) setError("Add or select a rider before starting a workout.");
              else void startRide(null, workout);
            }} />
          )}
          {activeView === "Games" && (
            <GamesPage
              busy={busy}
              native={isTauri()}
              onRoutes={() => setActiveView("Routes")}
              onStart={startGame}
              rides={rides}
              routeId={activeRoute?.id ?? routes[0]?.id ?? null}
              routeName={activeRoute?.name ?? routes[0]?.name ?? "Free ride course"}
              riderId={selectedRiderId}
            />
          )}
          {activeView === "Activities" && (
            <ActivitiesPage rides={rides} leaderboard={leaderboard} />
          )}
          {activeView === "Devices" && <DevicesPage status={status} />}
          {activeView === "Settings" && (
            <SettingsPage
              displayOpen={status?.secondaryDisplayOpen ?? false}
              idleMessage={idleMessage}
              messageError={messageError}
              onIdleMessage={updateIdleMessage}
              onManager={() => invoke("open_manager_console").catch((reason: unknown) => setError(String(reason)))}
              onOpenDisplay={() => void invoke("open_ride_display").then(refreshStatus).catch((reason: unknown) => setError(String(reason)))}
              onCloseDisplay={() => void invoke("close_ride_display").then(refreshStatus).catch((reason: unknown) => setError(String(reason)))}
              onVr={() => invoke("open_vr_companion").catch((reason: unknown) => setError(String(reason)))}
            />
          )}
          {activeView === "Ride" && (
            <>
              <div className="page-heading">
                <div><div className="eyebrow">{activeRide ? "SESSION IN PROGRESS" : "YOUR INDOOR CYCLING STUDIO"}</div>
                  <h1>{activeRide ? "Focus on the ride." : "Good evening. Ready to ride?"}</h1>
                  <p className="muted">{activeRide ? "Live ride metrics are synchronized to the display." : "Pick a route or jump into a free ride."}</p>
                </div>
                {!activeRide && <button className="primary-action quick-ride" disabled={busy || selectedRiderId === null} onClick={() => void startRide(null)}>Start free ride <span>→</span></button>}
              </div>
              {activeRide ? (
                <section className="ride-live-layout">
                  <div className="ride-metrics-grid">
                    <Metric label="Power" value={metrics.power} unit="W" accent="accent" />
                    <Metric label="Cadence" value={metrics.cadence} unit="RPM" />
                    <Metric label="Speed" value={metrics.speedKph.toFixed(1)} unit="km/h" />
                    <Metric label="Heart rate" value={metrics.heartRate} unit="BPM" accent="heart" />
                    <Metric label="Elapsed" value={formatDuration(metrics.elapsedSeconds)} unit="" />
                  </div>
                  {activeWorkout && <WorkoutProgress workout={activeWorkout} elapsedSeconds={metrics.elapsedSeconds} />}
                  {activeRace && (
                    <RaceGameView
                      currentDistanceKm={Math.min(activeRoute?.distanceKm ?? 5, metrics.speedKph * metrics.elapsedSeconds / 3600)}
                      elapsedSeconds={metrics.elapsedSeconds}
                      mode={activeRace.mode}
                      opponents={activeRace.referenceRides}
                      playerName={riders.find((rider) => rider.id === selectedRiderId)?.name ?? "You"}
                      routeDistanceKm={activeRoute?.distanceKm ?? 5}
                      routeName={activeRoute?.name ?? "Free ride course"}
                      speedKph={metrics.speedKph}
                    />
                  )}
                  {activeRoute && (
                    <RideRouteProgress
                      elapsedSeconds={metrics.elapsedSeconds}
                      route={activeRoute}
                      speedKph={metrics.speedKph}
                    />
                  )}
                  <div className="panel live-ride-banner"><div><div className="eyebrow">DEMO RIDE · SIMULATED DATA</div><p className="muted mt-2">No fitness equipment is connected. Metrics are a preview and saved locally.</p></div>
                    <button className="danger-action" disabled={busy} onClick={finishRide}>{busy ? "Saving…" : "Finish ride"}</button>
                  </div>
                </section>
              ) : (
                <section className="dashboard-grid">
                  <div className="panel rider-panel">
                    <div className="section-title-row"><div><div className="eyebrow">RIDER PROFILE</div><h2>Who's riding?</h2></div><span className="muted">{riders.length} profiles</span></div>
                    {riders.length ? <div className="rider-chips">{riders.map((rider) => (
                      <button className={`rider-chip ${rider.id === selectedRiderId ? "active" : ""}`} disabled={rider.locked} key={rider.id} onClick={() => setSelectedRiderId(rider.id)}>
                        <span className="rider-avatar">{rider.name.slice(0, 1)}</span>{rider.name}{rider.locked && <small>LOCKED</small>}
                      </button>
                    ))}</div> : <p className="muted">Create a local rider profile to start a session.</p>}
                    <div className="add-rider-row"><input maxLength={40} onChange={(event) => setNewRider(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void createRider(); }} placeholder="Add a rider" value={newRider} /><button className="secondary-action" disabled={busy || !newRider.trim()} onClick={createRider}>Add profile</button></div>
                  </div>
                  <div className="panel next-ride-panel">
                    <div className="eyebrow">QUICK START</div><h2>{selectedRouteId ? routes.find((route) => route.id === selectedRouteId)?.name : "Free ride"}</h2>
                    <p className="muted">{selectedRouteId ? "Selected course · preview simulation" : "Ride at your own pace with a simulated indoor course."}</p>
                    {selectedRouteId && <RoutePreview route={routes.find((route) => route.id === selectedRouteId)} />}
                    <button className="primary-action full-action" disabled={busy || selectedRiderId === null} onClick={() => void startRide()}>{busy ? "Starting…" : "Start demo ride"} <span>→</span></button>
                    <button className="text-action" onClick={() => setActiveView("Routes")}>Browse route library</button>
                  </div>
                  <div className="panel recent-panel"><div className="section-title-row"><div><div className="eyebrow">YOUR TRAINING</div><h2>Recent activity</h2></div><button className="text-action" onClick={() => setActiveView("Activities")}>View history →</button></div>
                    {rides.slice(0, 4).map((ride) => <RideRow key={ride.id} ride={ride} />)}
                    {rides.length === 0 && <p className="muted mt-4">Your completed rides will show here.</p>}
                  </div>
                  <div className="panel leaderboard-panel"><div className="eyebrow">COMMUNITY</div><h2>Distance leaderboard</h2>{leaderboard.slice(0, 5).map((entry, index) => <div className="leader-row" key={entry.riderId}><span className="leader-rank">{String(index + 1).padStart(2, "0")}</span><span>{entry.riderName}</span><strong>{entry.totalDistanceKm.toFixed(1)} <small>km</small></strong></div>)}</div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
      {studioRoute !== false && <RouteStudio
        initialName={studioRoute?.name}
        initialPoints={studioRoute?.points}
        onCancel={() => setStudioRoute(false)}
        onSave={saveCustomRoute}
        routeId={studioRoute?.id}
      />}
    </main>
  );
}

function Metric({ label, value, unit, accent }: { label: string; value: string | number; unit: string; accent?: string }) {
  return (
    <div className="panel">
      <div className="muted text-sm font-semibold uppercase tracking-widest">{label}</div>
      <div className={`mt-3 text-4xl font-black sm:text-5xl ${accent ?? ""}`}>{value}</div>
      <div className="muted mt-1">{unit}</div>
    </div>
  );
}

function RoutePreview({ route }: { route: Route | undefined }) {
  if (!route) return null;
  const elevations = route.points.map((point) => point.elevationM);
  const { minimum, maximum } = elevations.reduce(
    (range, elevation) => ({
      minimum: Math.min(range.minimum, elevation),
      maximum: Math.max(range.maximum, elevation),
    }),
    { minimum: Number.POSITIVE_INFINITY, maximum: Number.NEGATIVE_INFINITY },
  );
  const range = Math.max(1, maximum - minimum);
  const profile = elevations.map((elevation, index) => {
    const x = index / (elevations.length - 1) * 1000;
    const y = 120 - (elevation - minimum) / range * 100;
    return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return (
    <div className="mt-4 rounded-xl border border-slate-800 p-3">
      <div className="muted flex justify-between text-sm">
        <span>{route.name}</span>
        <span>{route.distanceKm.toFixed(2)} km · ↑{Math.round(route.elevationGainM)} m</span>
      </div>
      <svg aria-label={`${route.name} elevation profile`} className="mt-2 h-24 w-full" preserveAspectRatio="none" role="img" viewBox="0 0 1000 140">
        <path d={profile} fill="none" stroke="#06b6d4" strokeWidth="4" vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

function GamesPage({ busy, native, onRoutes, onStart, rides, routeId, routeName, riderId }: {
  busy: boolean;
  native: boolean;
  onRoutes: () => void;
  onStart: (mode: RaceSession["mode"]) => void;
  rides: Ride[];
  routeId: number | null;
  routeName: string;
  riderId: number | null;
}) {
  const routeRides = rides.filter((ride) =>
    ride.status === "completed" && ride.durationSeconds > 0 && ride.routeId === routeId);
  const hasPersonalBest = riderId !== null && routeRides.some((ride) => ride.riderId === riderId);
  const pastRiderCount = riderId === null ? 0 : new Set(
    routeRides.filter((ride) => ride.riderId !== riderId).map((ride) => ride.riderId),
  ).size;
  return (
    <>
      <div className="page-heading">
        <div><div className="eyebrow">WORKFIT PLAY</div><h1>Ride your own race.</h1><p className="muted">Take on a solo baseline, chase your best time, or line up against local rider ghosts.</p></div>
        <span className="subtle-badge">DEMO GAME MODE</span>
      </div>
      <section className="games-route-banner panel">
        <div><div className="eyebrow">RACE COURSE</div><strong>{routeName}</strong></div>
        <button className="text-action" onClick={onRoutes}>Change course in Routes →</button>
      </section>
      <div className="game-mode-grid">
        <GameModeCard
          accent="#06b6d4"
          action="Start solo test"
          description="Ride alone for two minutes and set a first benchmark. This demo baseline is saved in your ride history."
          disabled={busy || !native || riderId === null}
          eyebrow="NO OPPONENTS"
          icon="01"
          onStart={() => onStart("baseline")}
          title="Solo baseline"
        />
        <GameModeCard
          accent="#a78bfa"
          action={hasPersonalBest ? "Race your ghost" : "Ride this course first"}
          description="Your fastest completed time on this exact course appears as a rider ghost beside you."
          disabled={busy || !native || riderId === null || !hasPersonalBest}
          eyebrow={hasPersonalBest ? "PERSONAL BEST READY" : "NEEDS A SAVED RIDE"}
          icon="PB"
          onStart={() => onStart("personalBest")}
          title="Personal best"
        />
        <GameModeCard
          accent="#84cc16"
          action={pastRiderCount > 0 ? `Race ${pastRiderCount} rider${pastRiderCount === 1 ? "" : "s"}` : "Invite another rider"}
          description="Replay up to three completed rides from other local rider profiles as on-course bots."
          disabled={busy || !native || riderId === null || pastRiderCount === 0}
          eyebrow={pastRiderCount > 0 ? `${pastRiderCount} LOCAL RIDERS` : "NO PAST RIDERS"}
          icon="VS"
          onStart={() => onStart("pastRiders")}
          title="Past riders"
        />
      </div>
      <p className="game-hardware-note">
        Game rides currently use simulated demo power and speed because no bike sensor adapter is connected.
        The baseline is not a real effort measurement, and ghosts replay pace estimated from saved ride summaries.
      </p>
    </>
  );
}

function GameModeCard({ accent, action, description, disabled, eyebrow, icon, onStart, title }: {
  accent: string;
  action: string;
  description: string;
  disabled: boolean;
  eyebrow: string;
  icon: string;
  onStart: () => void;
  title: string;
}) {
  return (
    <article className="game-mode-card" style={{ borderTopColor: accent }}>
      <div className="game-mode-icon">{icon}</div>
      <div className="eyebrow">{eyebrow}</div>
      <h2>{title}</h2>
      <p className="muted">{description}</p>
      <button className="secondary-action" disabled={disabled} onClick={onStart}>{action} <span>→</span></button>
    </article>
  );
}

function RaceGameView({ currentDistanceKm, elapsedSeconds, mode, opponents, playerName, routeDistanceKm, routeName, speedKph }: {
  currentDistanceKm: number;
  elapsedSeconds: number;
  mode: RaceSession["mode"];
  opponents: Ride[];
  playerName: string;
  routeDistanceKm: number;
  routeName: string;
  speedKph: number;
}) {
  const baselineSeconds = 120;
  const playerProgress = mode === "baseline"
    ? Math.min(1, elapsedSeconds / baselineSeconds)
    : Math.min(1, currentDistanceKm / Math.max(0.1, routeDistanceKm));
  const racers = [
    ...opponents.map((ride) => ({
      key: `ghost-${ride.id}`,
      name: ride.riderName,
      isPlayer: false,
      progress: Math.min(1, (ride.distanceKm / Math.max(1, ride.durationSeconds) * elapsedSeconds) / Math.max(0.1, routeDistanceKm)),
    })),
    { key: "player", name: playerName, isPlayer: true, progress: playerProgress },
  ].sort((left, right) => right.progress - left.progress);
  const modeLabel = mode === "baseline"
    ? "SOLO BASELINE · 02:00 TARGET"
    : mode === "personalBest" ? "PERSONAL-BEST GHOST RACE" : "LOCAL PAST-RIDER RACE";
  return (
    <section aria-label="Cycling game race" className="game-race panel">
      <div className="game-race-heading">
        <div><div className="eyebrow">{modeLabel}</div><h2>{routeName}</h2></div>
        <div className="game-race-clock">{formatDuration(elapsedSeconds)}</div>
      </div>
      <div className="game-world" aria-label="Illustrated race course">
        <div className="game-world-sun" />
        <div className="game-world-hills" />
        <div className="game-world-road">
          <div className="game-road-edge" />
          <div className="game-road-dashes" />
          {racers.map((racer, index) => (
            <div
              aria-label={`${racer.name}${racer.isPlayer ? ", you" : ", bot"}, ${Math.round(racer.progress * 100)} percent`}
              className={`game-racer ${racer.isPlayer ? "game-racer-player" : ""}`}
              key={racer.key}
              style={{ left: `${Math.max(4, Math.min(92, racer.progress * 88))}%`, top: `${20 + index * 22}%` }}
            >
              <span className="game-racer-label">{racer.name}{racer.isPlayer ? " · YOU" : " · BOT"}</span>
              <RiderGlyph accent={racer.isPlayer ? "#06b6d4" : ["#a78bfa", "#84cc16", "#fb7185"][index % 3]} />
            </div>
          ))}
        </div>
      </div>
      <div className="game-race-footer">
        <span>{mode === "baseline" ? "Ride steadily for two minutes to save a baseline." : "Ghost pacing is estimated from saved ride summaries."}</span>
        <strong>{Math.round(speedKph)} <small>km/h · SIMULATED</small></strong>
      </div>
    </section>
  );
}

function RiderGlyph({ accent }: { accent: string }) {
  return (
    <svg aria-hidden="true" className="rider-glyph" viewBox="0 0 104 54">
      <circle cx="23" cy="38" fill="none" r="13" stroke="#d9e2e5" strokeWidth="2.4" />
      <circle cx="78" cy="38" fill="none" r="13" stroke="#d9e2e5" strokeWidth="2.4" />
      <path d="M23 38 39 22l14 16H23l11-21h12m-3 0 15 21h20L65 24H43" fill="none" stroke={accent} strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" />
      <circle cx="59" cy="7" fill="#f8fafc" r="5" />
      <path d="m56 13-12 9 13 6 7-10 9 5" fill="none" stroke={accent} strokeLinecap="round" strokeLinejoin="round" strokeWidth="4" />
    </svg>
  );
}

function pointAtDistance(points: RoutePoint[], distanceKm: number): RoutePoint | undefined {
  if (points.length === 0) return undefined;
  let remaining = Math.max(0, distanceKm);
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const latitudeDelta = (current.latitude - previous.latitude) * Math.PI / 180;
    const longitudeDelta = (current.longitude - previous.longitude) * Math.PI / 180;
    const previousLatitude = previous.latitude * Math.PI / 180;
    const currentLatitude = current.latitude * Math.PI / 180;
    const a = Math.sin(latitudeDelta / 2) ** 2
      + Math.cos(previousLatitude) * Math.cos(currentLatitude) * Math.sin(longitudeDelta / 2) ** 2;
    const segmentDistanceKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    if (remaining <= segmentDistanceKm) {
      const ratio = segmentDistanceKm > 0 ? remaining / segmentDistanceKm : 0;
      return {
        latitude: previous.latitude + (current.latitude - previous.latitude) * ratio,
        longitude: previous.longitude + (current.longitude - previous.longitude) * ratio,
        elevationM: previous.elevationM + (current.elevationM - previous.elevationM) * ratio,
      };
    }
    remaining -= segmentDistanceKm;
  }
  return points[points.length - 1];
}

function RideRouteProgress({ route, elapsedSeconds, speedKph }: {
  route: Route;
  elapsedSeconds: number;
  speedKph: number;
}) {
  const distanceTravelled = Math.min(route.distanceKm, speedKph * elapsedSeconds / 3600);
  const marker = pointAtDistance(route.points, distanceTravelled);
  return (
    <section className="panel ride-route-progress">
      <div className="section-title-row">
        <div><div className="eyebrow">ROUTE PROGRESS · SIMULATED</div><h2>{route.name}</h2></div>
        <strong>{distanceTravelled.toFixed(1)} <small>/ {route.distanceKm.toFixed(1)} km</small></strong>
      </div>
      <CourseMap color="#06b6d4" large marker={marker} points={route.points} />
      <div className="muted ride-route-caption">Position follows simulated speed along the route profile; this is not GPS or a street map.</div>
    </section>
  );
}

function RoutesPage({
  builtIns,
  customRoutes,
  savedRoutes,
  selectedRouteId,
  search,
  difficulty,
  onSearch,
  onDifficulty,
  onCreate,
  onEdit,
  onImport,
  onSelect,
  onStart,
}: {
  builtIns: typeof builtInRoutes;
  customRoutes: Route[];
  savedRoutes: Route[];
  selectedRouteId: number | null;
  search: string;
  difficulty: string;
  onSearch: (value: string) => void;
  onDifficulty: (value: string) => void;
  onCreate: () => void;
  onEdit: (route: Route) => void;
  onImport: (file?: File) => void;
  onSelect: (routeId: number) => void;
  onStart: (routeId: number) => void;
}) {
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [selectedCustomId, setSelectedCustomId] = useState<number | null>(null);
  const selectedBuiltin = builtIns.find((route) => route.slug === selectedSlug);
  const selectedCustom = customRoutes.find((route) => route.id === selectedCustomId);
  const allPoints = selectedBuiltin?.points ?? selectedCustom?.points ?? [];

  return (
    <>
      <div className="page-heading">
        <div><div className="eyebrow">RIDE LIBRARY · ROUTE STUDIO</div><h1>Choose your road.</h1><p className="muted">Explore 24 curated virtual courses or sketch your own from scratch.</p></div>
        <button className="primary-action" onClick={onCreate}><span>＋</span> Create a route</button>
      </div>
      <div className="route-toolbar">
        <div className="route-search"><span>⌕</span><input aria-label="Search routes" onChange={(event) => onSearch(event.target.value)} placeholder="Search courses or regions" value={search} /></div>
        <div className="difficulty-filter">
          {["All routes", "Easy", "Moderate", "Hard"].map((level) => <button className={difficulty === level ? "active" : ""} key={level} onClick={() => onDifficulty(level)}>{level}</button>)}
        </div>
        <label className="secondary-action import-route-button">Import GPX<input accept=".gpx,application/gpx+xml,application/xml,text/xml" onChange={(event) => onImport(event.currentTarget.files?.[0])} type="file" /></label>
      </div>
      {customRoutes.length > 0 && (
        <section className="route-section">
          <div className="section-title-row"><div><div className="eyebrow">YOUR COLLECTION</div><h2>My routes <span className="muted">({customRoutes.length})</span></h2></div></div>
          <div className="route-card-grid">
            {customRoutes.map((route, index) => <RouteCard key={route.id} route={route} color={["#06b6d4", "#84cc16", "#a78bfa", "#fb7185"][index % 4]} selected={selectedCustomId === route.id} onSelect={() => { setSelectedCustomId(route.id); setSelectedSlug(null); onSelect(route.id); }} />)}
          </div>
        </section>
      )}
      <section className="route-section">
        <div className="section-title-row"><div><div className="eyebrow">THE WORKFIT COLLECTION</div><h2>Featured courses <span className="muted">({builtIns.length})</span></h2></div><span className="muted virtual-tag">✦ All courses are original virtual routes</span></div>
        {builtIns.length ? (
          <div className="route-card-grid">
            {builtIns.map((route) => (
                <button
                  aria-pressed={selectedSlug === route.slug}
                  className={`course-card ${selectedSlug === route.slug ? "course-selected" : ""}`}
                  key={route.slug}
                  onClick={() => {
                    setSelectedSlug(route.slug);
                    setSelectedCustomId(null);
                    const saved = savedRoutes.find((item) => item.builtIn && item.name === route.name);
                    if (saved) onSelect(saved.id);
                  }}
                >
                  <CourseMap points={route.points} color={route.color} />
                  <div className="course-card-body">
                    <div className="course-region">{route.region.toUpperCase()} · {route.country}</div>
                    <h3>{route.name}</h3>
                    <div className="course-card-meta"><span>{route.distanceKm} km</span><span>↑ {route.elevationGainM} m</span><span className={`difficulty ${route.difficulty.toLowerCase()}`}>{route.difficulty}</span></div>
                  </div>
                </button>
            ))}
          </div>
        ) : <div className="empty-state">No routes match that search. Try another region or difficulty.</div>}
      </section>
      {(selectedBuiltin || selectedCustom) && (
        <section className="route-detail panel">
          <div className="detail-map"><CourseMap color={selectedBuiltin?.color ?? "#06b6d4"} points={allPoints} large /></div>
          <div className="route-detail-copy">
            <div className="eyebrow">{selectedBuiltin ? `${selectedBuiltin.region.toUpperCase()} · ORIGINAL VIRTUAL COURSE` : "YOUR CUSTOM COURSE"}</div>
            <h2>{selectedBuiltin?.name ?? selectedCustom?.name}</h2>
            <p className="muted">A virtual route profile for indoor rides. Elevation is a simulated course profile, not a verified road recording.</p>
            <div className="detail-stats"><span><strong>{selectedBuiltin?.distanceKm.toFixed(1) ?? selectedCustom?.distanceKm.toFixed(1)}</strong> km</span><span><strong>{Math.round(selectedBuiltin?.elevationGainM ?? selectedCustom?.elevationGainM ?? 0)}</strong> m climb</span><span><strong>{allPoints.length}</strong> points</span></div>
            <div className="route-detail-actions">
              {selectedCustom && <button className="secondary-action" onClick={() => onEdit(selectedCustom)}>Edit route</button>}
              <button className="primary-action" disabled={selectedRouteId === null} onClick={() => selectedRouteId !== null && onStart(selectedRouteId)}>Ride this course <span>→</span></button>
            </div>
          </div>
        </section>
      )}
      <div className="route-section import-inline">
        <div><div className="eyebrow">MAKE IT YOURS</div><h2>Have a GPX file?</h2><p className="muted">Import a route from your files to preview the elevation and ride its virtual profile.</p></div>
        <button className="secondary-action" onClick={onCreate}>Open Route Studio</button>
      </div>
    </>
  );
}

function RouteCard({ route, color, selected, onSelect }: { route: Route; color: string; selected: boolean; onSelect: () => void }) {
  return (
    <button aria-pressed={selected} className={`course-card ${selected ? "course-selected" : ""}`} onClick={onSelect}>
      <CourseMap color={color} points={route.points} />
      <div className="course-card-body"><div className="course-region">MY ROUTE</div><h3>{route.name}</h3><div className="course-card-meta"><span>{route.distanceKm.toFixed(1)} km</span><span>↑ {Math.round(route.elevationGainM)} m</span></div></div>
    </button>
  );
}

function CourseMap({ points, color, large = false, marker }: {
  points: RoutePoint[];
  color: string;
  large?: boolean;
  marker?: RoutePoint;
}) {
  if (points.length < 2) return <div className={`course-map ${large ? "large" : ""}`} />;
  const minLat = Math.min(...points.map((point) => point.latitude));
  const maxLat = Math.max(...points.map((point) => point.latitude));
  const minLon = Math.min(...points.map((point) => point.longitude));
  const maxLon = Math.max(...points.map((point) => point.longitude));
  const latRange = maxLat - minLat || 1;
  const lonRange = maxLon - minLon || 1;
  const line = points.map((point, index) => {
    const x = 12 + (point.longitude - minLon) / lonRange * 76;
    const y = 12 + (maxLat - point.latitude) / latRange * 76;
    return `${index ? "L" : "M"} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(" ");
  return (
    <div className={`course-map ${large ? "large" : ""}`}>
      <svg aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 100 100">
        <path d="M-4 78 C25 64 11 45 41 54 S69 28 106 13" fill="none" opacity=".16" stroke={color} strokeWidth="8" />
        <path d={line} fill="none" opacity=".3" stroke="#000" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4" />
        <path d={line} fill="none" stroke={color} strokeDasharray={large ? "none" : "none"} strokeLinecap="round" strokeLinejoin="round" strokeWidth={large ? "1.35" : "1.8"} />
        <circle cx={12 + (points[0].longitude - minLon) / lonRange * 76} cy={12 + (maxLat - points[0].latitude) / latRange * 76} fill="#f8fafc" r="2.5" />
        {marker && <circle
          className="route-position-marker"
          cx={12 + (marker.longitude - minLon) / lonRange * 76}
          cy={12 + (maxLat - marker.latitude) / latRange * 76}
          fill="#06b6d4"
          r="4"
          stroke="#f8fafc"
          strokeWidth="1.4"
        />}
      </svg>
      <span className="map-start">START</span>
      <span className="map-terrain">{large ? "ELEVATION PROFILE" : "VIRTUAL COURSE"}</span>
    </div>
  );
}

function WorkoutsPage({ onStart, disabled }: { onStart: (workout: WorkoutPlan) => void; disabled: boolean }) {
  return (
    <>
      <div className="page-heading"><div><div className="eyebrow">STRUCTURED TRAINING</div><h1>Workouts for your day.</h1><p className="muted">Choose a timed session with changing simulated power targets. Targets are a preview, not equipment control.</p></div><span className="subtle-badge">{workoutPlans.length} WORKOUTS</span></div>
      <div className="workout-grid">{workoutPlans.map((workout) => <article className="workout-card" key={workout.name}>
        <div aria-label={`${workout.name} intensity profile`} className="workout-chart" role="img">{workout.phases.map((phase, index) => <span key={`${phase.name}-${index}`} style={{ flexGrow: phase.durationMinutes, height: `${Math.round(phase.intensity * 78)}%`, backgroundColor: workout.color, opacity: index % 2 ? 0.72 : 1 }} />)}</div>
        <div className="eyebrow">{workout.focus.toUpperCase()}</div><h2>{workout.name}</h2><p className="muted">{workout.durationMinutes} min · {workout.phases.length} timed phases</p>
        <button className="secondary-action" disabled={disabled} onClick={() => onStart(workout)}>Start demo workout <span>→</span></button>
      </article>)}</div>
      <p className="muted workout-footnote">Demo workout targets are based on a 180 W reference and only shape simulated telemetry. No ERG resistance is sent to equipment.</p>
    </>
  );
}

function WorkoutProgress({ workout, elapsedSeconds }: { workout: WorkoutPlan; elapsedSeconds: number }) {
  const stage = workoutPhaseAt(workout, elapsedSeconds);
  const totalSeconds = workout.durationMinutes * 60;
  const progress = Math.min(100, elapsedSeconds / totalSeconds * 100);
  return (
    <section aria-label="Workout progress" className="panel workout-progress">
      <div className="workout-progress-heading">
        <div><div className="eyebrow">STRUCTURED DEMO WORKOUT</div><h2>{workout.name}</h2></div>
        <strong>{formatDuration(Math.min(elapsedSeconds, totalSeconds))} <span>/ {formatDuration(totalSeconds)}</span></strong>
      </div>
      <div aria-label="Workout completion" aria-valuemax={100} aria-valuemin={0} aria-valuenow={Math.round(progress)} className="workout-progress-track" role="progressbar">
        <span style={{ width: `${progress}%`, backgroundColor: workout.color }} />
      </div>
      <div className="workout-stage-row">
        <div><span className="muted">CURRENT PHASE</span><strong>{stage.phase?.name ?? "Workout complete"}</strong></div>
        <div><span className="muted">SIMULATED TARGET</span><strong>{stage.targetPower} W</strong></div>
        <div><span className="muted">{stage.phase ? "PHASE REMAINING" : "NEXT STEP"}</span><strong>{stage.phase ? formatDuration(stage.phaseRemainingSeconds) : "Finish ride when ready"}</strong></div>
      </div>
      <div aria-hidden="true" className="workout-phase-track">
        {workout.phases.map((phase, index) => <span
          className={phase === stage.phase ? "current" : ""}
          key={`${phase.name}-${index}`}
          style={{ backgroundColor: workout.color, flexGrow: phase.durationMinutes }}
          title={`${phase.name} · ${phase.durationMinutes} min`}
        />)}
      </div>
    </section>
  );
}

function ActivitiesPage({ rides, leaderboard }: { rides: Ride[]; leaderboard: LeaderboardEntry[] }) {
  const completed = rides.filter((ride) => ride.status === "completed");
  return (
    <>
      <div className="page-heading"><div><div className="eyebrow">TRAINING LOG</div><h1>Your activity.</h1><p className="muted">A local record of completed WorkFit rides.</p></div></div>
      <div className="summary-strip"><SummaryStat title="SESSIONS" value={String(completed.length)} /><SummaryStat title="TOTAL DISTANCE" value={`${completed.reduce((sum, ride) => sum + ride.distanceKm, 0).toFixed(1)} km`} /><SummaryStat title="BEST POWER" value={`${Math.max(0, ...completed.map((ride) => ride.maxPower))} W`} /></div>
      <div className="panel activity-list"><div className="eyebrow">RECENT SESSIONS</div>
        {rides.length ? rides.map((ride) => <RideRow key={ride.id} ride={ride} detailed />) : <div className="empty-state">No rides yet. Start a demo ride to begin your training history.</div>}
      </div>
      <div className="panel activity-leaderboard"><div className="eyebrow">ALL-TIME LOCAL LEADERBOARD</div>{leaderboard.length ? leaderboard.map((entry, index) => <div className="leader-row" key={entry.riderId}><span className="leader-rank">{String(index + 1).padStart(2, "0")}</span><span>{entry.riderName}</span><span className="muted">{entry.rides} rides</span><strong>{entry.totalDistanceKm.toFixed(1)} <small>km</small></strong></div>) : <p className="muted mt-4">Rankings appear after completing a ride.</p>}</div>
    </>
  );
}

function SummaryStat({ title, value }: { title: string; value: string }) {
  return <div className="panel summary-stat"><span className="eyebrow">{title}</span><strong>{value}</strong></div>;
}

function RideRow({ ride, detailed = false }: { ride: Ride; detailed?: boolean }) {
  return (
    <div className="ride-row">
      <span className="ride-date">{new Date(ride.startedAt * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
      <div className="ride-row-main"><strong>{ride.riderName}{ride.routeName ? ` · ${ride.routeName}` : " · Free ride"}</strong><span className="muted">{ride.source.toUpperCase()} · {ride.status}</span></div>
      <span>{ride.distanceKm.toFixed(1)} <small>km</small></span><span>{Math.round(ride.averagePower)} <small>W avg</small></span>
      {detailed && <span>{formatDuration(ride.durationSeconds)}</span>}
    </div>
  );
}

function DevicesPage({ status }: { status: KioskStatus | null }) {
  const [devices, setDevices] = useState<BluetoothHeartRateDevice[]>([]);
  const [connectedDevice, setConnectedDevice] = useState<BluetoothHeartRateConnection | null>(null);
  const [heartRate, setHeartRate] = useState<BluetoothHeartRateSample | null>(null);
  const [scanBusy, setScanBusy] = useState(false);
  const [connectBusy, setConnectBusy] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const native = isTauri();

  useEffect(() => {
    if (!native) return;
    let mounted = true;
    let receivedConnectionEvent = false;
    const unlisteners: (() => void)[] = [];
    const subscribe = async () => {
      const stopHeartRate = await listen<BluetoothHeartRateSample>("bluetooth-heart-rate", (event) => {
        if (mounted) {
          receivedConnectionEvent = true;
          setHeartRate(event.payload);
          setConnectedDevice({ id: event.payload.deviceId, name: event.payload.deviceName });
        }
      });
      if (!mounted) {
        stopHeartRate();
        return;
      }
      unlisteners.push(stopHeartRate);
      const stopDisconnected = await listen("bluetooth-disconnected", () => {
        if (mounted) {
          receivedConnectionEvent = true;
          setConnectedDevice(null);
          setHeartRate(null);
          void invoke("disconnect_bluetooth_heart_rate").catch((reason: unknown) => {
            if (mounted) setDeviceError(reason instanceof Error ? reason.message : String(reason));
          });
        }
      });
      if (!mounted) stopDisconnected();
      else unlisteners.push(stopDisconnected);
      const connection = await invoke<BluetoothHeartRateConnection | null>("get_connected_bluetooth_heart_rate");
      if (mounted && !receivedConnectionEvent) setConnectedDevice(connection);
    };
    subscribe().catch((reason: unknown) => {
      if (mounted) setDeviceError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      mounted = false;
      unlisteners.forEach((stop) => stop());
    };
  }, [native]);

  const scanBluetooth = async () => {
    setScanBusy(true);
    setDeviceError(null);
    try {
      setDevices(await invoke<BluetoothHeartRateDevice[]>("scan_bluetooth_heart_rate_devices"));
    } catch (reason) {
      setDeviceError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setScanBusy(false);
    }
  };

  const connectBluetooth = async (device: BluetoothHeartRateDevice) => {
    setConnectBusy(true);
    setDeviceError(null);
    try {
      const name = await invoke<string>("connect_bluetooth_heart_rate", { deviceId: device.id });
      setConnectedDevice({ id: device.id, name });
      setHeartRate(null);
    } catch (reason) {
      setDeviceError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setConnectBusy(false);
    }
  };

  const disconnectBluetooth = async () => {
    setConnectBusy(true);
    setDeviceError(null);
    try {
      await invoke("disconnect_bluetooth_heart_rate");
      setConnectedDevice(null);
      setHeartRate(null);
    } catch (reason) {
      setDeviceError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setConnectBusy(false);
    }
  };

  return (
    <>
      <div className="page-heading"><div><div className="eyebrow">EQUIPMENT & SENSORS</div><h1>Your connected devices.</h1><p className="muted">See WorkFit monitor and fitness-equipment connection status.</p></div></div>
      <div className="device-card-grid">
        <article className="panel device-card">
          <span className="device-icon">⌁</span>
          <h2>Bluetooth LE heart-rate sensor</h2>
          <p className="muted">Connects to Bluetooth-only sensors using the standard Heart Rate Service (180D). This path does not use ANT+.</p>
          <div className="device-status"><span className="status-dot" />{connectedDevice ? `Connected · ${connectedDevice.name}` : "Not connected"}</div>
          {heartRate && <div className="mt-3 text-2xl font-black heart">{heartRate.bpm} BPM</div>}
          {!native && <p className="muted mt-3">Bluetooth connections require the native WorkFit desktop app.</p>}
          {native && !connectedDevice && (
            <>
              <button className="secondary-action" disabled={scanBusy || connectBusy} onClick={() => void scanBluetooth()}>
                {scanBusy ? "Scanning Bluetooth…" : "Scan for Bluetooth sensors"}
              </button>
              {devices.map((device) => (
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3" key={device.id}>
                  <span>{device.name} · {device.rssi === null ? "Signal unavailable" : `${device.rssi} dBm`}</span>
                  <button disabled={connectBusy} onClick={() => void connectBluetooth(device)}>
                    {connectBusy ? "Connecting…" : "Connect"}
                  </button>
                </div>
              ))}
              {!scanBusy && devices.length === 0 && <p className="muted mt-3">Scan to find nearby sensors advertising the standard Bluetooth heart-rate service.</p>}
            </>
          )}
          {native && connectedDevice && (
            <button className="secondary-action" disabled={connectBusy} onClick={() => void disconnectBluetooth()}>
              {connectBusy ? "Disconnecting…" : "Disconnect sensor"}
            </button>
          )}
          {deviceError && <p className="mt-3 text-rose-300" role="alert">{deviceError}</p>}
        </article>
        <DeviceCard title="ANT+ FE-C trainer" kind="ANT+ USB dongle · power · cadence · speed · resistance control" status="Adapter not implemented or validated" />
        <DeviceCard title="Bluetooth smart trainer" kind="Bluetooth FTMS power · cadence · speed · resistance control" status="FTMS trainer control not implemented" />
        <DeviceCard title="Ride display" kind="Second-screen presentation" status={status?.secondaryDisplayOpen ? "Connected" : "Single display"} />
      </div>
      <div className="panel hardware-note"><div className="eyebrow">HARDWARE SUPPORT STATUS</div><p className="muted">Bluetooth LE heart-rate sensors that advertise the standard 180D service can stream live BPM here. This does not yet feed ride recording or calibrate effort. ANT+/FE-C trainer control, Bluetooth FTMS trainer control, and device-backed rides remain unavailable and require separate adapters and hardware validation. The Wattbike Atom Pro 2021 Model B and Huawei Band 8 are not validated.</p></div>
    </>
  );
}

function DeviceCard({ title, kind, status }: { title: string; kind: string; status: string }) {
  return <article className="panel device-card"><span className="device-icon">⌁</span><h2>{title}</h2><p className="muted">{kind}</p><div className="device-status"><span className="status-dot" />{status}</div><button className="secondary-action" disabled>Device adapter unavailable</button></article>;
}

function SettingsPage({
  displayOpen,
  idleMessage,
  messageError,
  onIdleMessage,
  onManager,
  onOpenDisplay,
  onCloseDisplay,
  onVr,
}: {
  displayOpen: boolean;
  idleMessage: string;
  messageError: string | null;
  onIdleMessage: (value: string) => void;
  onManager: () => void;
  onOpenDisplay: () => void;
  onCloseDisplay: () => void;
  onVr: () => void;
}) {
  const [pinConfigured, setPinConfigured] = useState<boolean | null>(null);
  const [settingsUnlocked, setSettingsUnlocked] = useState(false);
  const [pin, setPin] = useState("");
  const [currentPin, setCurrentPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinBusy, setPinBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    if (!isTauri()) {
      setPinConfigured(false);
      setSettingsUnlocked(true);
      return;
    }
    invoke<boolean>("settings_pin_is_set")
      .then((configured) => {
        if (!mounted) return;
        setPinConfigured(configured);
        setSettingsUnlocked(!configured);
      })
      .catch((reason: unknown) => {
        if (mounted) setPinError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      mounted = false;
      void invoke("lock_settings").catch(() => undefined);
    };
  }, []);

  const unlockOrSetPin = async () => {
    setPinBusy(true);
    setPinError(null);
    try {
      if (!isTauri()) {
        setPinError("PIN protection is available in the WorkFit desktop app.");
        return;
      }
      if (pinConfigured) {
        await invoke("unlock_settings", { pin });
      } else {
        await invoke("update_settings_pin", { currentPin: null, newPin: pin });
        await invoke("unlock_settings", { pin });
        setPinConfigured(true);
      }
      setSettingsUnlocked(true);
      setPin("");
    } catch (reason) {
      setPinError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPinBusy(false);
    }
  };

  const savePin = async () => {
    setPinBusy(true);
    setPinError(null);
    try {
      await invoke("update_settings_pin", {
        currentPin: currentPin || null,
        newPin: newPin || null,
      });
      setPinConfigured(Boolean(newPin));
      setCurrentPin("");
      setNewPin("");
      if (newPin) {
        await invoke("unlock_settings", { pin: newPin });
        setSettingsUnlocked(true);
      } else {
        setSettingsUnlocked(true);
      }
    } catch (reason) {
      setPinError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPinBusy(false);
    }
  };

  const lockSettings = async () => {
    try {
      await invoke("lock_settings");
      setSettingsUnlocked(false);
    } catch (reason) {
      setPinError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <>
      <div className="page-heading"><div><div className="eyebrow">PERSONALIZE YOUR SETUP</div><h1>App settings.</h1><p className="muted">Configure the ride screens and local WorkFit tools.</p></div></div>
      {pinConfigured === null ? <p className="muted">Loading settings access…</p> : !settingsUnlocked ? (
        <section className="panel settings-group settings-pin-gate">
          <div className="eyebrow">PROTECTED SETTINGS</div>
          <h2>{pinConfigured ? "Enter your settings PIN" : "Set a PIN to protect settings"}</h2>
          <p className="muted">{pinConfigured ? "Settings are locked on this kiosk." : "Choose a 4–12 digit PIN. It will be stored securely on this computer."}</p>
          <form onSubmit={(event) => { event.preventDefault(); void unlockOrSetPin(); }}>
            <input
              aria-label="Settings PIN"
              autoComplete="current-password"
              className="settings-input"
              inputMode="numeric"
              maxLength={12}
              onChange={(event) => setPin(event.target.value)}
              pattern="[0-9]{4,12}"
              required
              type="password"
              value={pin}
            />
            <button className="primary-action" disabled={pinBusy}>{pinBusy ? "Working…" : pinConfigured ? "Unlock settings" : "Set PIN and unlock"}</button>
          </form>
          {pinError && <p className="error-message" role="alert">{pinError}</p>}
        </section>
      ) : (
        <>
          {pinConfigured && <section className="panel settings-group">
            <div className="section-title-row">
              <div><div className="eyebrow">SETTINGS ACCESS</div><h2>PIN protection is on</h2></div>
              <button className="secondary-action" onClick={() => void lockSettings()}>Lock settings</button>
            </div>
            <div className="settings-pin-fields">
              <input aria-label="Current settings PIN" autoComplete="current-password" className="settings-input" inputMode="numeric" maxLength={12} onChange={(event) => setCurrentPin(event.target.value)} placeholder="Current PIN" type="password" value={currentPin} />
              <input aria-label="New settings PIN" autoComplete="new-password" className="settings-input" inputMode="numeric" maxLength={12} onChange={(event) => setNewPin(event.target.value)} placeholder="New PIN (blank removes PIN)" type="password" value={newPin} />
              <button className="secondary-action" disabled={pinBusy || !currentPin} onClick={() => void savePin()}>{newPin ? "Change PIN" : "Remove PIN"}</button>
            </div>
            {pinError && <p className="error-message" role="alert">{pinError}</p>}
          </section>}
          <section className="panel settings-group">
            <div className="eyebrow">RIDE DISPLAY</div><h2>{displayOpen ? "Ride display is open" : "Ride display is closed"}</h2>
            <p className="muted">WorkFit does not enter kiosk mode. Open or close the separate ride screen whenever you want.</p>
            <div className="settings-actions">
              {displayOpen
                ? <button className="secondary-action" onClick={onCloseDisplay}>Close ride display</button>
                : <button className="secondary-action" onClick={onOpenDisplay}>Open ride display</button>}
            </div>
          </section>
          <section className="panel settings-group"><div className="eyebrow">SECONDARY DISPLAY</div><h2>Ambient message</h2><p className="muted">Shown on the ride display while you are not riding.</p><input className="settings-input" maxLength={120} onChange={(event) => onIdleMessage(event.target.value)} value={idleMessage} />{messageError && <p className="error-message">{messageError}</p>}</section>
          <section className="panel settings-group"><div className="eyebrow">WORKFIT COMPANIONS</div><h2>Separate applications</h2><p className="muted">The Manager Console launches as a separate WorkFit app. VR companion access is read-only.</p><div className="settings-actions"><button className="secondary-action" onClick={onManager}>Open WorkFit Manager</button><button className="secondary-action" onClick={onVr}>Open VR companion</button></div></section>
          <section className="panel settings-group"><div className="eyebrow">LOCAL STORAGE</div><h2>Your workout data stays on this computer.</h2><p className="muted">Profiles, routes, metrics and settings are kept in the WorkFit application data folder.</p></section>
        </>
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<ControlApp />);
