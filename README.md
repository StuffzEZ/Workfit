# WorkFit

WorkFit is a Tauri v2 desktop fitness kiosk with a React/TypeScript frontend and a local SQLite data store. It includes a dual-display kiosk flow, local rider profiles, route import, demo workouts, ride history, and a local manager console.

## Development

Requirements: Node.js 20.19+ (or 22.12+), Rust stable, and the platform prerequisites for [Tauri v2](https://v2.tauri.app/start/prerequisites/).

```powershell
npm install
npm run tauri:dev
```

The production frontend can be checked independently with `npm run build`. `npm run tauri:build` creates the native application bundle.
For a browser-only UI preview, run `npm run dev` and open `http://127.0.0.1:1420/control.html`; rider storage and ride actions require the native Tauri app.
WorkFit opens as a normal resizable desktop window, not fullscreen kiosk mode. The optional ride display is opened and closed from Settings. The standalone Manager app has separate commands: `npm run manager:dev` for development and `npm run manager:build` for its separate native bundle.

## Frontend entry points

- `control.html`: primary touchscreen kiosk.
- `display.html`: optional ride display (uses a second monitor when available, otherwise opens on the primary display).
- `manager.html`: local manager console (opened from the kiosk).
- `vr.html`: read-only telemetry companion (opened from the kiosk).

The Manager Console is a separate native app target which shares the local WorkFit database. In development, the main app starts its Manager target with Cargo if the sibling binary has not yet been built; installed builds can set `WORKFIT_MANAGER_EXECUTABLE` to its location. The Manager Console provides **local-only** rider locking and kiosk locking. It is not network-accessible. The VR companion remains a separate read-only telemetry window.

## Implemented

- Launch in a standard resizable desktop window; a separate ride display can be opened manually from Settings, on a secondary monitor when available or as another primary-display window otherwise.
- Persist riders, route files, ride summaries, telemetry samples, and kiosk settings in `workfit.sqlite` under the platform's Tauri app-data directory.
- Create and locally lock/unlock rider profiles. Rider names are unique without regard to case.
- Import GPX track/route points, validate coordinates/elevation, calculate distance and climb, and display a route elevation preview.
- Navigate a desktop-style sidebar for rides, routes, workouts, activities, devices, and settings. Browse 24 fictional virtual courses, search or filter by difficulty, or build and edit custom routes by adding, dragging, removing, and adjusting the elevation of individual waypoints. Imported GPX tracks can be edited against their own coordinate range.
- Exit the native WorkFit app from the sidebar. Browser previews attempt to close the tab and explain when the browser requires closing it manually.
- Optionally protect kiosk settings with a 4–12 digit PIN stored as an Argon2 password hash. The PIN gate is enforced by the native settings command, and settings relock when leaving the Settings page.
- Open and close the optional ride display manually; neither the main app nor the ride display forces fullscreen kiosk mode.
- Start one of six structured demo workouts with timed warm-up, effort, recovery, and cool-down phases. Live power values follow each phase's simulated target; no equipment resistance is controlled.
- Play from the Games section: complete a two-minute solo demo baseline, chase a personal-best ghost, or race up to three unique past-rider ghosts on the selected course. The race view visualizes riders on a road scene and tracks progress around the route. Opponent pace is estimated from saved ride summaries.
- Start explicitly labeled **demo rides**; simulated power, cadence, speed, heart-rate, grade, and elapsed time stream to the ride display and VR companion and are saved locally. A route ride shows a simulated moving position on its course profile. Ride statistics include duration, distance, mean/max power, cadence, heart rate, and estimated calories.
- Scan for and connect to standard Bluetooth LE Heart Rate Service (0x180D) sensors, including devices that have no ANT+ radio. Bluetooth BPM is shown live in Devices. This heart-rate feed does not yet populate or control ride records.
- Show recent rides and an all-time completed-distance leaderboard.
- Change and persist the secondary display's ambient message.
- Lock the primary kiosk with a staff message or lock individual rider profiles from the local Manager Console.
- Restrict native commands by Tauri window label. VR is limited to telemetry reads; the Manager Console does not receive ride-control or host-shutdown capabilities.

## Hardware and network limitations

Demo ride metrics are synthetic and **must not be mistaken for sensor readings**. Bluetooth LE heart-rate monitoring supports only the standard 0x180D service and displays sensor BPM separately; it is not used as demo ride telemetry. ANT+/FE-C device integration is not implemented, and device-backed rides are rejected. No resistance commands are sent to fitness equipment.

Race and baseline modes are currently game previews driven by synthetic demo telemetry; they do not respond to pedal input or calibrate real rider power until a supported sensor adapter is implemented.

In particular, the Wattbike Atom Pro 2021 Model B (ANT+ only) has not been connected or validated; WorkFit does not currently provide an ANT+ FE-C adapter for it. Bluetooth heart-rate support requires a device that advertises the standard Bluetooth Heart Rate Service; Huawei Band 8 heart-rate streaming is not supported because it has not been validated as exposing that service, and WorkFit does not connect to Huawei Health. These devices must not be presented as connected or supported yet.

GPX is used to preview a route and simulate its grade in demo rides; there is no synchronized route video, FIT parser, real resistance control, or 3D/WebXR world yet. The VR companion is a native read-only telemetry window, not an immersive headset renderer. Idle HLS/DASH/Jellyfin/video playback is not implemented.

The route studio edits GPX/user-created tracks and the built-in fictional courses. It does not use Google Maps or Street View: those require Google API credentials, billing, and compliant map attribution. Camera/IR head steering is not implemented. Live ride screens do not embed Jellyfin or M3U8 streams.

The separate Manager app shares local rider/session storage, but no remote WebSocket server/client, certificate provisioning/pairing, mTLS/HMAC session, remote host shutdown, remote forced login, or battery/CPU telemetry is implemented. Those actions remain unavailable rather than being exposed through an unauthenticated or unprovisioned channel.

When a secondary monitor is available, the optional ride display opens there; without one, it opens as a regular window on the primary display.
