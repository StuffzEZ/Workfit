import type { RoutePoint } from "../../types";

export const BUILT_IN_CATALOG_VERSION = 2;

export type BuiltInRoute = {
  slug: string;
  name: string;
  region: string;
  country: string;
  difficulty: "Easy" | "Moderate" | "Hard";
  distanceKm: number;
  elevationGainM: number;
  color: string;
  points: RoutePoint[];
};

const regions = [
  { name: "Alpine Switchbacks", region: "Alps", country: "CH", length: 18, climb: 740, difficulty: "Hard" as const, color: "#ff795e" },
  { name: "Lakeside Tempo", region: "Lake District", country: "GB", length: 32, climb: 260, difficulty: "Moderate" as const, color: "#28c6b7" },
  { name: "Coastal Spin", region: "Atlantic Coast", country: "PT", length: 24, climb: 180, difficulty: "Easy" as const, color: "#48a9ff" },
  { name: "Forest Roller", region: "Black Forest", country: "DE", length: 27, climb: 410, difficulty: "Moderate" as const, color: "#a4d66d" },
  { name: "Volcano Ascent", region: "Canary Islands", country: "ES", length: 22, climb: 980, difficulty: "Hard" as const, color: "#f5ad50" },
  { name: "River Valley", region: "Loire Valley", country: "FR", length: 41, climb: 220, difficulty: "Easy" as const, color: "#a18bff" },
];

const variations = [
  { label: "Dawn Loop", scale: 1, climb: 0.8 },
  { label: "Long Circuit", scale: 1.55, climb: 1.1 },
  { label: "Short Climb", scale: 0.7, climb: 1.35 },
  { label: "Evening Run", scale: 1.2, climb: 0.9 },
];

function coursePoints(seed: number, targetDistanceKm: number, targetClimbM: number): RoutePoint[] {
  const centerLat = 44 + (seed % 18) * 1.05;
  const centerLon = -4 + (seed % 24) * 2.2;
  const points = Array.from({ length: 24 }, (_, index) => {
    const angle = index / 23 * Math.PI * 2;
    const modulation = 1 + 0.18 * Math.sin(index * 2.4 + seed);
    return {
      latitude: centerLat + Math.sin(angle) * 0.055 * modulation + Math.sin(index * 0.7 + seed) * 0.006,
      longitude: centerLon + Math.cos(angle) * 0.075 * modulation + Math.cos(index * 1.1 + seed) * 0.007,
      elevationM: Math.sin(angle * 2 + seed * 0.3) * 0.18
        + Math.cos(angle * 3 + seed) * 0.09 + (index / 23) * 0.2,
    };
  });
  const rawDistance = points.slice(1).reduce((sum, point, index) => {
    const previous = points[index];
    const dx = (point.longitude - previous.longitude) * 111.32 * Math.cos(previous.latitude * Math.PI / 180);
    const dy = (point.latitude - previous.latitude) * 111.32;
    return sum + Math.hypot(dx, dy);
  }, 0);
  const distanceScale = targetDistanceKm / rawDistance;
  const unscaledClimb = points.slice(1).reduce(
    (sum, point, index) => sum + Math.max(0, point.elevationM - points[index].elevationM),
    0,
  );
  const elevationScale = targetClimbM / unscaledClimb;
  return points.map((point) => ({
    latitude: centerLat + (point.latitude - centerLat) * distanceScale,
    longitude: centerLon + (point.longitude - centerLon) * distanceScale,
    elevationM: 100 + point.elevationM * elevationScale,
  }));
}

export const builtInRoutes: BuiltInRoute[] = regions.flatMap((region, regionIndex) =>
  variations.map((variation, variationIndex) => ({
    slug: `${region.name.toLowerCase().replaceAll(" ", "-")}-${variation.label.toLowerCase().replaceAll(" ", "-")}`,
    name: `${region.name} · ${variation.label}`,
    region: region.region,
    country: region.country,
    difficulty: region.difficulty,
    distanceKm: Number((region.length * variation.scale).toFixed(1)),
    elevationGainM: Math.round(region.climb * variation.climb),
    color: region.color,
    points: coursePoints(
      regionIndex * 5 + variationIndex,
      region.length * variation.scale,
      region.climb * variation.climb,
    ),
  })),
);
