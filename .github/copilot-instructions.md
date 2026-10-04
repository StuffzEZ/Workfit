# WorkFit repository instructions

## Build and run

Requirements are Node.js 20.19+ (or 22.12+), stable Rust, and the Tauri v2 platform prerequisites.

- `npm install` installs frontend and Tauri CLI dependencies.
- `npm run dev` starts the browser preview at `http://127.0.0.1:1420/control.html`. The browser preview does not provide native Tauri commands, local rider storage, or ride actions.
- `npm run build` runs the TypeScript project build (`tsc -b`) and Vite production build for all four HTML entry points.
- `npm run tauri:dev` and `npm run tauri:build` run the primary desktop app.
- `npm run manager:dev` and `npm run manager:build` use `src-tauri/tauri.manager.conf.json` and the `workfit-manager` Rust binary for the separate Manager app.
- `cargo check --manifest-path src-tauri/Cargo.toml` checks the Rust crate.
- `cargo test --manifest-path src-tauri/Cargo.toml` runs the Rust unit tests. To run one test, append its name as a filter, for example: `cargo test --manifest-path src-tauri/Cargo.toml telemetry_requires_finite_bounded_and_increasing_time_values`.

There is no frontend test runner or lint script configured in `package.json`. Rust unit tests live in the `src-tauri/src/lib.rs` test module.

## Architecture

- Vite builds four HTML entry points: `control.html` (primary kiosk UI), `display.html` (secondary ride display), `manager.html` (Manager UI), and `vr.html` (read-only telemetry companion). Their React entry points are under `src/apps/`; `vite.config.ts` is the source of truth for the multi-page build and the primary dev server port.
- `src/apps/kiosk/control.tsx` orchestrates the primary UI, view navigation, ride/workout/race state, and Tauri calls. Route editing is in `RouteStudio.tsx`; the fictional built-in route catalog and its version are in `routeCatalog.ts`. Shared frontend IPC shapes are defined in `src/types.ts`, and the app-wide theme/layout is in `src/styles.css`.
- `src-tauri/src/lib.rs` owns native state, SQLite persistence/schema setup, Tauri commands, display-window management, and event emission. The frontend calls commands with `invoke` and listens for ride/display events with `listen`; command results and events should remain consistent with the shared TypeScript types. Rust structs use Serde camelCase for the JavaScript boundary.
- `src-tauri/src/bluetooth.rs` handles standard Bluetooth LE Heart Rate Service discovery, subscriptions, and notification parsing. Its BPM event is separate from demo ride telemetry; keep ANT+ FE-C and Bluetooth trainer support distinct rather than treating one transport as a substitute for the other.
- The main app and Manager are separate Tauri configurations and runtime targets, but share `workfit.sqlite` in the Tauri app-data directory. `manager.rs` is the Manager binary entry point; `run_manager` in `lib.rs` opens the existing database rather than initializing a new one.
- Tauri window labels are an authorization boundary. Native commands in `lib.rs` check the caller label/access role; the Manager has a deliberately smaller command handler, and the VR companion is limited to telemetry reads. Preserve and update both checks and command registration when changing IPC behavior. The default capability is in `src-tauri/capabilities/default.json`.

## Repository-specific conventions

- Treat the README's implemented-feature and hardware/network-limitations sections as the authoritative behavior boundary. Ride metrics, workouts, baselines, and race pacing are simulated. Bluetooth LE support is limited to separate live BPM monitoring for standard Heart Rate Service devices; it is not ride telemetry. ANT+/FE-C, trainer resistance control, Google Maps/Street View, live media streaming, and the network Manager protocol are not implemented. Keep device connection and telemetry claims explicitly accurate.
- Persist kiosk data through native commands and the SQLite connection in `KioskState`; do not substitute browser storage for native persistence. Keep database/schema compatibility changes in `initialize_schema` and its existing migration logic in `src-tauri/src/lib.rs`.
- When adding a Tauri command, implement its caller authorization, register it in the appropriate `generate_handler!` list (`run`, `run_manager`, or both only if intended), and update the frontend invocation/types and window capabilities as needed. Prefer returning descriptive `Result<_, String>` errors across the IPC boundary.
- Ride/display/VR updates are emitted as Tauri events by the native backend; keep event names and payload shapes aligned with listeners in the relevant app entry points.
- Built-in routes are synchronized from `routeCatalog.ts` into local storage using `BUILT_IN_CATALOG_VERSION`. Increment that catalog version when changing existing built-in route definitions so installed databases refresh them.
- The desktop app is windowed by default. The secondary display is opened explicitly from Settings; do not make kiosk fullscreen or require a second monitor for normal startup.
- Keep the Manager a separate app target/configuration rather than treating its page as a second control-panel view. It is local-only and shares storage with the primary app.
