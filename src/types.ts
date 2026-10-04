export type Rider = {
  id: number;
  name: string;
  locked: boolean;
  createdAt: number;
};

export type Ride = {
  id: number;
  riderId: number;
  riderName: string;
  startedAt: number;
  endedAt: number | null;
  durationSeconds: number;
  averagePower: number;
  maxPower: number;
  averageCadence: number;
  averageHeartRate: number;
  distanceKm: number;
  calories: number;
  status: string;
  source: "demo" | "device";
  routeId: number | null;
  routeName: string | null;
};

export type RoutePoint = { latitude: number; longitude: number; elevationM: number };
export type Route = {
  id: number;
  name: string;
  distanceKm: number;
  elevationGainM: number;
  pointCount: number;
  points: RoutePoint[];
  builtIn: boolean;
  catalogVersion: number | null;
};

export type RideMetrics = {
  power: number;
  cadence: number;
  speedKph: number;
  heartRate: number;
  grade: number;
  elapsedSeconds: number;
};

export type KioskStatus = {
  displays: {
    name: string | null;
    x: number;
    y: number;
    width: number;
    height: number;
    isPrimary: boolean;
  }[];
  secondaryDisplayOpen: boolean;
  activeRide: boolean;
  lockMessage: string | null;
};

export type LeaderboardEntry = {
  riderId: number;
  riderName: string;
  rides: number;
  totalDistanceKm: number;
  bestPower: number;
};

export type RaceMode = "baseline" | "personalBest" | "pastRiders";
export type RaceSession = {
  mode: RaceMode;
  referenceRides: Ride[];
};
