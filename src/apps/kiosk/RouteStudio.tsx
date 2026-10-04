import { useState } from "react";
import type { MouseEvent, PointerEvent } from "react";
import type { RoutePoint } from "../../types";

const WORLD_SIZE = 100;

type Props = {
  initialName?: string;
  initialPoints?: RoutePoint[];
  routeId?: number;
  onSave: (name: string, points: RoutePoint[], routeId?: number) => Promise<void>;
  onCancel: () => void;
};

function routeBounds(points: RoutePoint[]) {
  if (points.length === 0) return { minLat: -0.02, maxLat: 0.02, minLon: -0.02, maxLon: 0.02 };
  const extents = points.reduce((bounds, point) => ({
    minLat: Math.min(bounds.minLat, point.latitude),
    maxLat: Math.max(bounds.maxLat, point.latitude),
    minLon: Math.min(bounds.minLon, point.longitude),
    maxLon: Math.max(bounds.maxLon, point.longitude),
  }), {
    minLat: Number.POSITIVE_INFINITY,
    maxLat: Number.NEGATIVE_INFINITY,
    minLon: Number.POSITIVE_INFINITY,
    maxLon: Number.NEGATIVE_INFINITY,
  });
  const latitudeRange = Math.max(0.01, extents.maxLat - extents.minLat);
  const longitudeRange = Math.max(0.01, extents.maxLon - extents.minLon);
  const latitudePadding = latitudeRange * 0.12;
  const longitudePadding = longitudeRange * 0.12;
  return {
    minLat: extents.minLat - latitudePadding,
    maxLat: extents.maxLat + latitudePadding,
    minLon: extents.minLon - longitudePadding,
    maxLon: extents.maxLon + longitudePadding,
  };
}

function toWorld(point: RoutePoint, bounds: ReturnType<typeof routeBounds>) {
  return {
    x: (point.longitude - bounds.minLon) / (bounds.maxLon - bounds.minLon) * WORLD_SIZE,
    y: (bounds.maxLat - point.latitude) / (bounds.maxLat - bounds.minLat) * WORLD_SIZE,
  };
}

function fromWorld(x: number, y: number, elevationM: number, bounds: ReturnType<typeof routeBounds>): RoutePoint {
  return {
    latitude: bounds.maxLat - y / WORLD_SIZE * (bounds.maxLat - bounds.minLat),
    longitude: bounds.minLon + x / WORLD_SIZE * (bounds.maxLon - bounds.minLon),
    elevationM,
  };
}

function distanceKm(points: RoutePoint[]) {
  return points.slice(1).reduce((sum, point, index) => {
    const previous = points[index];
    const dx = (point.longitude - previous.longitude) * 111.32 * Math.cos(previous.latitude * Math.PI / 180);
    const dy = (point.latitude - previous.latitude) * 111.32;
    return sum + Math.hypot(dx, dy);
  }, 0);
}

export function RouteStudio({ initialName = "", initialPoints = [], routeId, onSave, onCancel }: Props) {
  const [name, setName] = useState(initialName);
  const [points, setPoints] = useState<RoutePoint[]>(initialPoints);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elevation, setElevation] = useState(180);
  const [selectedPoint, setSelectedPoint] = useState<number | null>(null);
  const distance = distanceKm(points);
  const elevationGain = points.slice(1).reduce((sum, point, index) =>
    sum + Math.max(0, point.elevationM - points[index].elevationM), 0);
  const bounds = routeBounds(points);
  const projected = points.map((point) => toWorld(point, bounds));
  const path = projected.map((point, index) =>
    `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");

  const addPoint = (event: MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(2, Math.min(98, (event.clientX - rect.left) / rect.width * WORLD_SIZE));
    const y = Math.max(2, Math.min(98, (event.clientY - rect.top) / rect.height * WORLD_SIZE));
    setSelectedPoint(points.length);
    setPoints((current) => [...current, fromWorld(x, y, elevation, bounds)]);
  };

  const movePoint = (index: number, event: PointerEvent<SVGCircleElement>) => {
    const rect = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.max(2, Math.min(98, (event.clientX - rect.left) / rect.width * WORLD_SIZE));
    const y = Math.max(2, Math.min(98, (event.clientY - rect.top) / rect.height * WORLD_SIZE));
    setPoints((current) => current.map((point, pointIndex) =>
      pointIndex === index ? fromWorld(x, y, point.elevationM, bounds) : point));
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(name, points, routeId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="studio-backdrop" role="presentation">
      <section aria-labelledby="studio-title" aria-modal="true" className="studio-dialog" role="dialog">
        <header className="studio-header">
          <div>
            <div className="eyebrow">Route workshop</div>
            <h2 id="studio-title">{routeId === undefined ? "Build a route" : "Edit your route"}</h2>
            <p className="muted">Click to add waypoints, drag to reshape the course, and select a point to adjust its elevation.</p>
          </div>
          <button aria-label="Close route builder" className="icon-button" onClick={onCancel}>×</button>
        </header>
        <div className="studio-body">
          <div className="studio-map-wrap">
            <svg
              aria-label="Click map to add a route point"
              className="studio-map"
              onClick={addPoint}
              role="application"
              viewBox="0 0 100 100"
            >
              <defs>
                <pattern height="10" id="studio-grid" patternUnits="userSpaceOnUse" width="10">
                  <path d="M 10 0 L 0 0 0 10" fill="none" stroke="#223039" strokeWidth="0.25" />
                </pattern>
              </defs>
              <rect fill="#0b1115" height="100" width="100" />
              <rect fill="url(#studio-grid)" height="100" width="100" />
              <path d="M5 76 C20 70 19 42 35 48 S48 80 64 70 80 30 96 22" fill="none" opacity=".18" stroke="#06b6d4" strokeWidth="5" />
              {points.length > 1 && <path d={path} fill="none" stroke="#84cc16" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.2" />}
              {projected.map((point, index) => (
                <circle
                  key={`${index}-${point.x.toFixed(2)}-${point.y.toFixed(2)}`}
                  className="route-point"
                  cx={point.x}
                  cy={point.y}
                  fill={index === 0 ? "#06b6d4" : selectedPoint === index ? "#f8fafc" : "#84cc16"}
                  onClick={(event) => {
                    event.stopPropagation();
                    setSelectedPoint(index);
                    setElevation(Math.round(points[index].elevationM));
                  }}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    event.currentTarget.setPointerCapture(event.pointerId);
                  }}
                  onPointerMove={(event) => { if (event.buttons === 1) movePoint(index, event); }}
                  r="1.6"
                  stroke="#08090a"
                  strokeWidth=".6"
                />
              ))}
              {points.length > 0 && <text fill="#f8fafc" fontSize="3" x={projected[0].x + 2} y={projected[0].y - 2}>START</text>}
            </svg>
            <div className="map-hint">CLICK MAP TO ADD · DRAG OR SELECT A WAYPOINT</div>
          </div>
          <aside className="studio-controls">
            <label className="field-label" htmlFor="route-name">Route name</label>
            <input id="route-name" maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="My custom loop" value={name} />
            <div className="studio-stats">
              <div><span>Distance</span><strong>{distance.toFixed(1)} <small>km</small></strong></div>
              <div><span>Climbing</span><strong>{Math.round(elevationGain)} <small>m</small></strong></div>
              <div><span>Waypoints</span><strong>{points.length}</strong></div>
            </div>
            <label className="field-label" htmlFor="route-elevation">{selectedPoint === null ? "Elevation for next point" : `Elevation · waypoint ${selectedPoint + 1}`}</label>
            <div className="elevation-control">
              <input id="route-elevation" max="10000" min="-100" onChange={(event) => {
                const nextElevation = Number(event.target.value);
                setElevation(nextElevation);
                if (selectedPoint !== null) {
                  setPoints((current) => current.map((point, index) =>
                    index === selectedPoint ? { ...point, elevationM: nextElevation } : point));
                }
              }} type="range" value={elevation} />
              <output>{elevation} m</output>
            </div>
            {selectedPoint !== null && <button className="secondary-action" disabled={points.length <= 2} onClick={() => {
              setPoints((current) => current.filter((_, index) => index !== selectedPoint));
              setSelectedPoint(null);
            }}>Remove selected waypoint</button>}
            <button className="secondary-action" disabled={points.length === 0} onClick={() => {
              setPoints((current) => current.slice(0, -1));
              setSelectedPoint(null);
            }}>Undo last point</button>
            <button className="secondary-action" disabled={points.length === 0} onClick={() => {
              setPoints([]);
              setSelectedPoint(null);
            }}>Clear route</button>
            {error && <p className="error-message" role="alert">{error}</p>}
            <div className="studio-actions">
              <button className="secondary-action" onClick={onCancel}>Cancel</button>
              <button className="primary-action" disabled={busy || !name.trim() || points.length < 2} onClick={() => void save()}>
                {busy ? "Saving…" : "Save route"}
              </button>
            </div>
          </aside>
        </div>
      </section>
    </div>
  );
}
