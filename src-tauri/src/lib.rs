mod bluetooth;

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use rand_core::OsRng;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{path::Path, process::Command, sync::Mutex, time::SystemTime};
use tauri::{
    AppHandle, Emitter, Manager, Monitor, PhysicalPosition, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

struct KioskState {
    database: Mutex<Connection>,
    active_ride: Mutex<Option<i64>>,
    settings_unlocked: Mutex<bool>,
    bluetooth_heart_rate: Mutex<Option<bluetooth::HeartRateSession>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rider {
    id: i64,
    name: String,
    locked: bool,
    created_at: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Ride {
    id: i64,
    rider_id: i64,
    rider_name: String,
    started_at: i64,
    ended_at: Option<i64>,
    duration_seconds: i64,
    average_power: f64,
    max_power: i64,
    average_cadence: f64,
    average_heart_rate: f64,
    distance_km: f64,
    calories: u32,
    status: String,
    source: String,
    route_id: Option<i64>,
    route_name: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoutePoint {
    latitude: f64,
    longitude: f64,
    elevation_m: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Route {
    id: i64,
    name: String,
    distance_km: f64,
    elevation_gain_m: f64,
    point_count: usize,
    points: Vec<RoutePoint>,
    built_in: bool,
    catalog_version: Option<u32>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
enum RideSource {
    Demo,
    Device,
}

impl RideSource {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Demo => "demo",
            Self::Device => "device",
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RideMetrics {
    power: u16,
    cadence: u16,
    speed_kph: f64,
    heart_rate: u16,
    grade: f64,
    elapsed_seconds: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LeaderboardEntry {
    rider_id: i64,
    rider_name: String,
    rides: u32,
    total_distance_km: f64,
    best_power: i64,
}

fn unix_time() -> Result<i64, String> {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .map_err(|error| format!("System clock is before the Unix epoch: {error}"))
}

fn initialize_database(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path)
        .map_err(|error| format!("Could not open the WorkFit database: {error}"))?;
    initialize_schema(&connection)?;
    Ok(connection)
}

fn open_manager_database(path: &Path) -> Result<Connection, String> {
    if !path.is_file() {
        return Err(
            "Open WorkFit once to initialize local storage before opening WorkFit Manager.".into(),
        );
    }
    Connection::open(path).map_err(|error| format!("Could not open the WorkFit database: {error}"))
}

fn initialize_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;
             PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS riders (
                 id INTEGER PRIMARY KEY,
                 name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                 locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
                 created_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS rides (
                 id INTEGER PRIMARY KEY,
                 rider_id INTEGER NOT NULL REFERENCES riders(id),
                 started_at INTEGER NOT NULL,
                 ended_at INTEGER,
                 duration_seconds INTEGER NOT NULL DEFAULT 0,
                 average_power REAL NOT NULL DEFAULT 0,
                 max_power INTEGER NOT NULL DEFAULT 0,
                 average_cadence REAL NOT NULL DEFAULT 0,
                 average_heart_rate REAL NOT NULL DEFAULT 0,
                 distance_km REAL NOT NULL DEFAULT 0,
                 calories INTEGER NOT NULL DEFAULT 0,
                 status TEXT NOT NULL DEFAULT 'active',
                 source TEXT NOT NULL DEFAULT 'device' CHECK (source IN ('demo', 'device'))
             );
             CREATE TABLE IF NOT EXISTS telemetry (
                 id INTEGER PRIMARY KEY,
                 ride_id INTEGER NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
                 elapsed_seconds INTEGER NOT NULL,
                 power INTEGER NOT NULL,
                 cadence INTEGER NOT NULL,
                 speed_kph REAL NOT NULL,
                 heart_rate INTEGER NOT NULL,
                 grade REAL NOT NULL,
                 UNIQUE (ride_id, elapsed_seconds)
             );
             CREATE TABLE IF NOT EXISTS routes (
                 id INTEGER PRIMARY KEY,
                 name TEXT NOT NULL,
                 distance_km REAL NOT NULL,
                 elevation_gain_m REAL NOT NULL,
                 points_json TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 catalog_slug TEXT UNIQUE,
                 catalog_version INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS settings (
                 key TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS rides_rider_started ON rides(rider_id, started_at DESC);
             CREATE INDEX IF NOT EXISTS telemetry_ride_elapsed ON telemetry(ride_id, elapsed_seconds);",
        )
        .map_err(|error| format!("Could not initialize the WorkFit database: {error}"))?;
    connection
        .execute(
            "INSERT OR IGNORE INTO settings (key, value)
             VALUES ('idle_message', 'Tap the primary screen to start your ride')",
            [],
        )
        .map_err(|error| db_error("Could not initialize kiosk settings", error))?;
    connection
        .execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES ('kiosk_lock_message', '')",
            [],
        )
        .map_err(|error| db_error("Could not initialize kiosk lock state", error))?;
    let mut statement = connection
        .prepare("PRAGMA table_info(rides)")
        .map_err(|error| db_error("Could not inspect ride schema", error))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| db_error("Could not inspect ride schema", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| db_error("Could not inspect ride schema", error))?;
    drop(statement);
    if !columns.iter().any(|column| column == "source") {
        connection
            .execute(
                "ALTER TABLE rides ADD COLUMN source TEXT NOT NULL DEFAULT 'device'",
                [],
            )
            .map_err(|error| db_error("Could not upgrade ride schema", error))?;
    }
    if !columns.iter().any(|column| column == "route_id") {
        connection
            .execute(
                "ALTER TABLE rides ADD COLUMN route_id INTEGER REFERENCES routes(id)",
                [],
            )
            .map_err(|error| db_error("Could not upgrade ride route schema", error))?;
    }
    let mut route_statement = connection
        .prepare("PRAGMA table_info(routes)")
        .map_err(|error| db_error("Could not inspect route schema", error))?;
    let route_columns = route_statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| db_error("Could not inspect route schema", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| db_error("Could not inspect route schema", error))?;
    drop(route_statement);
    if !route_columns.iter().any(|column| column == "catalog_slug") {
        connection
            .execute("ALTER TABLE routes ADD COLUMN catalog_slug TEXT", [])
            .map_err(|error| db_error("Could not upgrade route catalog schema", error))?;
    }
    if !route_columns
        .iter()
        .any(|column| column == "catalog_version")
    {
        connection
            .execute(
                "ALTER TABLE routes ADD COLUMN catalog_version INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|error| db_error("Could not upgrade route catalog version", error))?;
    }
    connection
        .execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS routes_catalog_slug
             ON routes(catalog_slug)",
            [],
        )
        .map_err(|error| db_error("Could not index built-in routes", error))?;
    let now = unix_time()?;
    connection
        .execute(
            "UPDATE rides SET status = 'interrupted', ended_at = ?1
             WHERE status = 'active'",
            [now],
        )
        .map_err(|error| format!("Could not recover interrupted rides: {error}"))?;
    Ok(())
}

#[tauri::command]
fn set_kiosk_lock(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, KioskState>,
    message: Option<String>,
) -> Result<(), String> {
    authorize_window(window.label(), CommandAccess::Manager)?;
    let message = match message {
        Some(message) => {
            let message = message.trim();
            if message.is_empty() || message.chars().count() > 240 {
                return Err("Lock messages must contain 1 to 240 characters.".into());
            }
            message.to_owned()
        }
        None => String::new(),
    };
    let connection = state
        .database
        .lock()
        .map_err(|error| format!("Could not access kiosk settings: {error}"))?;
    connection
        .execute(
            "UPDATE settings SET value = ?1 WHERE key = 'kiosk_lock_message'",
            [&message],
        )
        .map_err(|error| db_error("Could not update kiosk lock state", error))?;
    drop(connection);
    if app.get_webview_window("control").is_some() {
        app.emit_to("control", "kiosk-lock-updated", message)
            .map_err(|error| format!("Kiosk lock changed but its notification failed: {error}"))?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DisplayStatus {
    name: Option<String>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    is_primary: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KioskStatus {
    displays: Vec<DisplayStatus>,
    secondary_display_open: bool,
    active_ride: bool,
    lock_message: Option<String>,
}

fn same_monitor(left: &Monitor, right: &Monitor) -> bool {
    left.name() == right.name()
        && left.position() == right.position()
        && left.size() == right.size()
}

fn validate_idle_message(message: String) -> Result<String, String> {
    let message = message.trim();
    if message.is_empty() || message.chars().count() > 120 {
        return Err("The idle message must contain 1 to 120 characters.".into());
    }
    Ok(message.to_owned())
}

fn settings_pin_exists(state: &KioskState) -> Result<bool, String> {
    let connection = state
        .database
        .lock()
        .map_err(|error| format!("Could not access kiosk settings: {error}"))?;
    connection
        .query_row(
            "SELECT 1 FROM settings WHERE key = 'settings_pin_hash'",
            [],
            |_| Ok(()),
        )
        .optional()
        .map(|value| value.is_some())
        .map_err(|error| db_error("Could not check settings PIN", error))
}

fn settings_are_unlocked(state: &KioskState) -> Result<bool, String> {
    state
        .settings_unlocked
        .lock()
        .map(|unlocked| *unlocked)
        .map_err(|error| format!("Could not check settings access: {error}"))
}

fn require_settings_unlocked(label: &str, state: &KioskState) -> Result<(), String> {
    if label == "control" && settings_pin_exists(state)? && !settings_are_unlocked(state)? {
        return Err("Unlock kiosk settings with your PIN before making changes.".into());
    }
    Ok(())
}

fn verify_settings_pin(encoded_hash: &str, pin: &str) -> Result<bool, String> {
    let parsed_hash = PasswordHash::new(encoded_hash)
        .map_err(|error| format!("Could not read settings PIN hash: {error}"))?;
    Ok(Argon2::default()
        .verify_password(pin.as_bytes(), &parsed_hash)
        .is_ok())
}

fn validate_pin(pin: &str) -> Result<(), String> {
    if !(4..=12).contains(&pin.len()) || !pin.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("PINs must contain 4 to 12 digits.".into());
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum CommandAccess {
    Control,
    Manager,
    ControlOrManager,
    LocalRead,
    DisplayRead,
    TelemetryRead,
}

fn authorize_window(label: &str, access: CommandAccess) -> Result<(), String> {
    let allowed = match access {
        CommandAccess::Control => label == "control",
        CommandAccess::Manager => label == "manager",
        CommandAccess::ControlOrManager => label == "control" || label == "manager",
        CommandAccess::LocalRead => label == "control" || label == "manager",
        CommandAccess::DisplayRead => {
            label == "control" || label == "display" || label == "manager"
        }
        CommandAccess::TelemetryRead => label == "control" || label == "manager" || label == "vr",
    };
    if allowed {
        return Ok(());
    }
    if label == "vr" {
        return Err("The VR companion is restricted to read-only telemetry.".into());
    }
    Err(format!(
        "The {label} window is not permitted to perform this action."
    ))
}

#[tauri::command]
async fn scan_bluetooth_heart_rate_devices(
    window: WebviewWindow,
) -> Result<Vec<bluetooth::HeartRateDevice>, String> {
    authorize_window(window.label(), CommandAccess::Control)?;
    bluetooth::scan_heart_rate_devices().await
}

#[tauri::command]
fn get_connected_bluetooth_heart_rate(
    window: WebviewWindow,
    state: State<'_, KioskState>,
) -> Result<Option<bluetooth::ConnectedHeartRateDevice>, String> {
    authorize_window(window.label(), CommandAccess::Control)?;
    bluetooth::connected_heart_rate(&state.bluetooth_heart_rate)
}

#[tauri::command]
async fn connect_bluetooth_heart_rate(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, KioskState>,
    device_id: String,
) -> Result<String, String> {
    authorize_window(window.label(), CommandAccess::Control)?;
    bluetooth::connect_heart_rate(app, &state.bluetooth_heart_rate, device_id).await
}

#[tauri::command]
async fn disconnect_bluetooth_heart_rate(
    window: WebviewWindow,
    state: State<'_, KioskState>,
) -> Result<(), String> {
    authorize_window(window.label(), CommandAccess::Control)?;
    bluetooth::disconnect_heart_rate(&state.bluetooth_heart_rate).await
}

#[tauri::command]
fn get_idle_message(window: WebviewWindow, state: State<'_, KioskState>) -> Result<String, String> {
    authorize_window(window.label(), CommandAccess::DisplayRead)?;
    let connection = state
        .database
        .lock()
        .map_err(|error| format!("Could not access kiosk settings: {error}"))?;
    connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'idle_message'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| db_error("Could not read the idle message", error))
}

#[tauri::command]
fn set_idle_message(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, KioskState>,
    message: String,
) -> Result<(), String> {
    authorize_window(window.label(), CommandAccess::ControlOrManager)?;
    let message = validate_idle_message(message)?;
    require_settings_unlocked(window.label(), &state)?;

    let connection = state
        .database
        .lock()
        .map_err(|error| format!("Could not access kiosk settings: {error}"))?;
    connection
        .execute(
            "UPDATE settings SET value = ?1 WHERE key = 'idle_message'",
            [&message],
        )
        .map_err(|error| db_error("Could not save the idle message", error))?;
    drop(connection);
    if app.get_webview_window("display").is_some() {
        app.emit_to("display", "idle-message-updated", message)
            .map_err(|error| format!("Could not notify the ride display: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn settings_pin_is_set(
    window: WebviewWindow,
    state: State<'_, KioskState>,
) -> Result<bool, String> {
    authorize_window(window.label(), CommandAccess::Control)?;
    settings_pin_exists(&state)
}

#[tauri::command]
fn unlock_settings(
    window: WebviewWindow,
    state: State<'_, KioskState>,
    pin: String,
) -> Result<(), String> {
    authorize_window(window.label(), CommandAccess::Control)?;
    let connection = state
        .database
        .lock()
        .map_err(|error| format!("Could not access kiosk settings: {error}"))?;
    let encoded_hash = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'settings_pin_hash'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| db_error("Could not read settings PIN", error))?
        .ok_or_else(|| "No settings PIN has been set.".to_owned())?;
    if !verify_settings_pin(&encoded_hash, &pin)? {
        return Err("That PIN is not correct.".into());
    }
    drop(connection);
    *state
        .settings_unlocked
        .lock()
        .map_err(|error| format!("Could not unlock kiosk settings: {error}"))? = true;
    Ok(())
}

#[tauri::command]
fn lock_settings(window: WebviewWindow, state: State<'_, KioskState>) -> Result<(), String> {
    authorize_window(window.label(), CommandAccess::Control)?;
    *state
        .settings_unlocked
        .lock()
        .map_err(|error| format!("Could not lock kiosk settings: {error}"))? = false;
    Ok(())
}

#[tauri::command]
fn update_settings_pin(
    window: WebviewWindow,
    state: State<'_, KioskState>,
    current_pin: Option<String>,
    new_pin: Option<String>,
) -> Result<(), String> {
    authorize_window(window.label(), CommandAccess::Control)?;
    let connection = state
        .database
        .lock()
        .map_err(|error| format!("Could not access kiosk settings: {error}"))?;
    let current_hash = connection
        .query_row(
            "SELECT value FROM settings WHERE key = 'settings_pin_hash'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| db_error("Could not read settings PIN", error))?;
    if let Some(hash) = current_hash {
        let Some(pin) = current_pin.as_deref() else {
            return Err("Enter the current PIN to change or remove it.".into());
        };
        if !verify_settings_pin(&hash, pin)? {
            return Err("The current PIN is not correct.".into());
        }
    }
    let encoded_hash = if let Some(pin) = new_pin {
        validate_pin(&pin)?;
        let salt = SaltString::generate(&mut OsRng);
        Some(
            Argon2::default()
                .hash_password(pin.as_bytes(), &salt)
                .map_err(|error| format!("Could not secure the settings PIN: {error}"))?
                .to_string(),
        )
    } else {
        None
    };
    if let Some(hash) = encoded_hash {
        connection
            .execute(
                "INSERT INTO settings (key, value) VALUES ('settings_pin_hash', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [&hash],
            )
            .map_err(|error| db_error("Could not save settings PIN", error))?;
    } else {
        connection
            .execute("DELETE FROM settings WHERE key = 'settings_pin_hash'", [])
            .map_err(|error| db_error("Could not remove settings PIN", error))?;
    }
    drop(connection);
    *state
        .settings_unlocked
        .lock()
        .map_err(|error| format!("Could not update settings access: {error}"))? = false;
    Ok(())
}

#[tauri::command]
fn get_kiosk_status(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, KioskState>,
) -> Result<KioskStatus, String> {
    authorize_window(window.label(), CommandAccess::LocalRead)?;
    let primary = app
        .primary_monitor()
        .map_err(|error| format!("Could not inspect the primary display: {error}"))?;
    let monitors = app
        .available_monitors()
        .map_err(|error| format!("Could not inspect connected displays: {error}"))?;
    let in_process_ride = state
        .active_ride
        .lock()
        .map_err(|error| format!("Could not check active ride: {error}"))?
        .is_some();
    let displays = monitors
        .iter()
        .map(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            DisplayStatus {
                name: monitor.name().cloned(),
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
                is_primary: primary
                    .as_ref()
                    .is_some_and(|primary| same_monitor(primary, monitor)),
            }
        })
        .collect();
    let connection = state
        .database
        .lock()
        .map_err(|error| format!("Could not access kiosk settings: {error}"))?;
    let active_ride = in_process_ride
        || connection
            .query_row(
                "SELECT 1 FROM rides WHERE status = 'active' LIMIT 1",
                [],
                |_| Ok(()),
            )
            .optional()
            .map_err(|error| db_error("Could not read active ride state", error))?
            .is_some();

    Ok(KioskStatus {
        displays,
        secondary_display_open: app.get_webview_window("display").is_some(),
        active_ride,
        lock_message: connection
            .query_row(
                "SELECT value FROM settings WHERE key = 'kiosk_lock_message'",
                [],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| db_error("Could not read kiosk lock state", error))
            .map(|message| {
                if message.is_empty() {
                    None
                } else {
                    Some(message)
                }
            })?,
    })
}

fn db_error(action: &str, error: rusqlite::Error) -> String {
    format!("{action}: {error}")
}

#[tauri::command]
fn list_riders(window: WebviewWindow, state: State<'_, KioskState>) -> Result<Vec<Rider>, String> {
    authorize_window(window.label(), CommandAccess::LocalRead)?;
    let connection = state
        .database
        .lock()
        .map_err(|error| format!("Could not access rider storage: {error}"))?;
    let mut statement = connection
        .prepare("SELECT id, name, locked, created_at FROM riders ORDER BY name COLLATE NOCASE")
        .map_err(|error| db_error("Could not list riders", error))?;
    let riders = statement
        .query_map([], |row| {
            Ok(Rider {
                id: row.get(0)?,
                name: row.get(1)?,
                locked: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(|error| db_error("Could not read riders", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| db_error("Could not read riders", error))?;
    Ok(riders)
}

#[tauri::command]
fn create_rider(
    window: WebviewWindow,
    state: State<'_, KioskState>,
    name: String,
) -> Result<Rider, String> {
    authorize_window(window.label(), CommandAccess::Control)?;
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 40 {
        return Err("Rider names must contain 1 to 40 characters.".into());
    }
    let created_at = unix_time()?;
    let connection = state
        .database
        .lock()
        .map_err(|error| format!("Could not access rider storage: {error}"))?;
    connection
        .execute(
            "INSERT INTO riders (name, created_at) VALUES (?1, ?2)",
            params![name, created_at],
        )
        .map_err(|error| db_error("Could not create rider (names must be unique)", error))?;
    Ok(Rider {
        id: connection.last_insert_rowid(),
        name: name.to_owned(),
        locked: false,
        created_at,
    })
}

#[tauri::command]
fn set_rider_locked(
    window: WebviewWindow,
    state: State<'_, KioskState>,
    rider_id: i64,
    locked: bool,
) -> Result<(), String> {
    authorize_window(window.label(), CommandAccess::Manager)?;
    let connection = state
        .database
        .lock()
        .map_err(|error| format!("Could not access rider storage: {error}"))?;
    let changed = connection
        .execute(
            "UPDATE riders SET locked = ?1 WHERE id = ?2",
            params![locked, rider_id],
        )
        .map_err(|error| db_error("Could not update rider lock", error))?;
    if changed == 0 {
        return Err("Rider does not exist.".into());
    }
    Ok(())
}

fn route_distance_m(left: &RoutePoint, right: &RoutePoint) -> f64 {
    let latitude_delta = (right.latitude - left.latitude).to_radians();
    let longitude_delta = (right.longitude - left.longitude).to_radians();
    let left_latitude = left.latitude.to_radians();
    let right_latitude = right.latitude.to_radians();
    let a = (latitude_delta / 2.0).sin().powi(2)
        + left_latitude.cos() * right_latitude.cos() * (longitude_delta / 2.0).sin().powi(2);
    6_371_000.0 * 2.0 * a.sqrt().atan2((1.0 - a).sqrt())
}

fn validate_route(
    name: String,
    points: Vec<RoutePoint>,
) -> Result<(String, f64, f64, String), String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err("Route names must contain 1 to 80 characters.".into());
    }
    if !(2..=50_000).contains(&points.len()) {
        return Err("A route must contain between 2 and 50,000 track points.".into());
    }
    for point in &points {
        if !point.latitude.is_finite()
            || !(-90.0..=90.0).contains(&point.latitude)
            || !point.longitude.is_finite()
            || !(-180.0..=180.0).contains(&point.longitude)
            || !point.elevation_m.is_finite()
            || !(-500.0..=10_000.0).contains(&point.elevation_m)
        {
            return Err("The GPX route contains invalid coordinates or elevation.".into());
        }
    }
    let mut distance_m = 0.0;
    let mut elevation_gain_m = 0.0;
    for pair in points.windows(2) {
        distance_m += route_distance_m(&pair[0], &pair[1]);
        elevation_gain_m += (pair[1].elevation_m - pair[0].elevation_m).max(0.0);
    }
    if distance_m <= 0.0 || !distance_m.is_finite() {
        return Err("The route must cover a non-zero distance.".into());
    }
    let points_json = serde_json::to_string(&points)
        .map_err(|error| format!("Could not encode route points: {error}"))?;
    Ok((
        name.to_owned(),
        distance_m / 1000.0,
        elevation_gain_m,
        points_json,
    ))
}

#[tauri::command]
fn save_route(
    window: WebviewWindow,
    state: State<'_, KioskState>,
    name: String,
    points: Vec<RoutePoint>,
    catalog_slug: Option<String>,
    catalog_version: Option<u32>,
    route_id: Option<i64>,
) -> Result<Route, String> {
    authorize_window(window.label(), CommandAccess::Control)?;
    let (name, distance_km, elevation_gain_m, points_json) = validate_route(name, points)?;
    let created_at = unix_time()?;
    let connection = state
        .database
        .lock()
        .map_err(|error| format!("Could not access route storage: {error}"))?;
    if catalog_slug.is_some() {
        connection
            .execute(
                "INSERT INTO routes
                 (name, distance_km, elevation_gain_m, points_json, created_at, catalog_slug, catalog_version)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(catalog_slug) DO UPDATE SET
                     name = excluded.name,
                     distance_km = excluded.distance_km,
                     elevation_gain_m = excluded.elevation_gain_m,
                     points_json = excluded.points_json,
                     catalog_version = excluded.catalog_version",
                params![
                    name,
                    distance_km,
                    elevation_gain_m,
                    points_json,
                    created_at,
                    catalog_slug,
                    catalog_version.unwrap_or(0)
                ],
            )
            .map_err(|error| db_error("Could not save built-in route", error))?;
    } else if let Some(route_id) = route_id {
        let changed = connection
            .execute(
                "UPDATE routes
                 SET name = ?1, distance_km = ?2, elevation_gain_m = ?3, points_json = ?4
                 WHERE id = ?5 AND catalog_slug IS NULL",
                params![name, distance_km, elevation_gain_m, points_json, route_id],
            )
            .map_err(|error| db_error("Could not update custom route", error))?;
        if changed == 0 {
            return Err("Only existing custom routes can be edited.".into());
        }
    } else {
        connection
            .execute(
                "INSERT INTO routes
                 (name, distance_km, elevation_gain_m, points_json, created_at, catalog_slug, catalog_version)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, 0)",
                params![name, distance_km, elevation_gain_m, points_json, created_at],
            )
            .map_err(|error| db_error("Could not save route", error))?;
    }
    let (id, name, distance_km, elevation_gain_m, points_json, slug, stored_version): (
        i64,
        String,
        f64,
        f64,
        String,
        Option<String>,
        u32,
    ) = if let Some(slug) = catalog_slug {
        connection
            .query_row(
                "SELECT id, name, distance_km, elevation_gain_m, points_json, catalog_slug, catalog_version
                 FROM routes WHERE catalog_slug = ?1",
                [&slug],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .map_err(|error| db_error("Could not load built-in route", error))?
    } else {
        let id = route_id.unwrap_or_else(|| connection.last_insert_rowid());
        (
            id,
            name,
            distance_km,
            elevation_gain_m,
            points_json,
            None,
            0,
        )
    };
    let points: Vec<RoutePoint> = serde_json::from_str(&points_json)
        .map_err(|error| format!("Could not decode saved route: {error}"))?;
    Ok(Route {
        id,
        name,
        distance_km,
        elevation_gain_m,
        point_count: points.len(),
        points,
        built_in: slug.is_some(),
        catalog_version: slug.map(|_| stored_version),
    })
}

#[tauri::command]
fn list_routes(window: WebviewWindow, state: State<'_, KioskState>) -> Result<Vec<Route>, String> {
    authorize_window(window.label(), CommandAccess::LocalRead)?;
    let connection = state
        .database
        .lock()
        .map_err(|error| format!("Could not access route storage: {error}"))?;
    let mut statement = connection
        .prepare("SELECT id, name, distance_km, elevation_gain_m, points_json, catalog_slug, catalog_version FROM routes ORDER BY name COLLATE NOCASE")
        .map_err(|error| db_error("Could not prepare route list", error))?;
    let routes = statement
        .query_map([], |row| {
            let points: Vec<RoutePoint> =
                serde_json::from_str(&row.get::<_, String>(4)?).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        4,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
            Ok(Route {
                id: row.get(0)?,
                name: row.get(1)?,
                distance_km: row.get(2)?,
                elevation_gain_m: row.get(3)?,
                point_count: points.len(),
                points,
                built_in: row.get::<_, Option<String>>(5)?.is_some(),
                catalog_version: row.get(6)?,
            })
        })
        .map_err(|error| db_error("Could not read routes", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| db_error("Could not read routes", error))?;
    Ok(routes)
}

#[tauri::command]
fn start_ride(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, KioskState>,
    rider_id: i64,
    source: RideSource,
    route_id: Option<i64>,
) -> Result<i64, String> {
    authorize_window(window.label(), CommandAccess::Control)?;
    if matches!(source, RideSource::Device) {
        return Err(
            "Device-backed rides require a validated power-trainer adapter; a Bluetooth heart-rate sensor alone cannot provide cycling power.".into(),
        );
    }
    let mut active_ride = state
        .active_ride
        .lock()
        .map_err(|error| format!("Could not check active ride: {error}"))?;
    if active_ride.is_some() {
        return Err("A ride is already active.".into());
    }
    let started_at = unix_time()?;
    let connection = state
        .database
        .lock()
        .map_err(|error| format!("Could not access ride storage: {error}"))?;
    let unlocked = connection
        .query_row(
            "SELECT locked FROM riders WHERE id = ?1",
            [rider_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| db_error("Could not find rider", error))?;
    if unlocked {
        return Err("This rider is locked.".into());
    }
    if let Some(route_id) = route_id {
        connection
            .query_row(
                "SELECT id FROM routes WHERE id = ?1",
                [route_id],
                |_| Ok(()),
            )
            .map_err(|error| db_error("Could not find the selected route", error))?;
    }
    connection
        .execute(
            "INSERT INTO rides (rider_id, started_at, source, route_id) VALUES (?1, ?2, ?3, ?4)",
            params![rider_id, started_at, source.as_str(), route_id],
        )
        .map_err(|error| db_error("Could not start ride", error))?;
    let ride_id = connection.last_insert_rowid();
    *active_ride = Some(ride_id);
    drop(connection);
    app.emit_to("display", "ride-started", ride_id)
        .map_err(|error| format!("Ride started but display notification failed: {error}"))?;
    app.emit_to("manager", "ride-started", ride_id)
        .map_err(|error| format!("Ride started but manager notification failed: {error}"))?;
    Ok(ride_id)
}

fn validate_metrics(metrics: &RideMetrics) -> Result<(), String> {
    if metrics.power > 2500
        || metrics.cadence > 250
        || !metrics.speed_kph.is_finite()
        || !(0.0..=150.0).contains(&metrics.speed_kph)
        || metrics.heart_rate > 250
        || !metrics.grade.is_finite()
        || !(-30.0..=30.0).contains(&metrics.grade)
    {
        return Err("Telemetry values are outside supported equipment limits.".into());
    }
    if metrics.elapsed_seconds == 0 {
        return Err("Telemetry elapsed time must be greater than zero.".into());
    }
    Ok(())
}

fn estimate_calories(watt_seconds: f64) -> u32 {
    (watt_seconds.max(0.0) / 1004.0).round() as u32
}

fn finish_ride(connection: &Connection, ride_id: i64, ended_at: i64) -> Result<Ride, String> {
    let watt_seconds = connection
        .query_row(
            "SELECT COALESCE(SUM(power), 0) FROM telemetry WHERE ride_id = ?1",
            [ride_id],
            |row| row.get::<_, f64>(0),
        )
        .map_err(|error| db_error("Could not calculate ride energy", error))?;
    let calories = estimate_calories(watt_seconds);
    connection
        .execute(
            "UPDATE rides SET
                 ended_at = ?1,
                 duration_seconds = MAX(0, ?1 - started_at),
                 average_power = COALESCE((SELECT AVG(power) FROM telemetry WHERE ride_id = ?2), 0),
                 max_power = COALESCE((SELECT MAX(power) FROM telemetry WHERE ride_id = ?2), 0),
                 average_cadence = COALESCE((SELECT AVG(cadence) FROM telemetry WHERE ride_id = ?2), 0),
                 average_heart_rate = COALESCE((SELECT AVG(NULLIF(heart_rate, 0)) FROM telemetry WHERE ride_id = ?2), 0),
                 distance_km = COALESCE((SELECT SUM(speed_kph / 3600.0) FROM telemetry WHERE ride_id = ?2), 0),
                 calories = ?3,
                 status = 'completed'
             WHERE id = ?2",
            params![ended_at, ride_id, calories],
        )
        .map_err(|error| db_error("Could not finish ride", error))?;
    connection
        .query_row(
            "SELECT rides.id, rides.rider_id, riders.name, rides.started_at, rides.ended_at,
                    rides.duration_seconds, rides.average_power, rides.max_power, rides.average_cadence,
                    rides.average_heart_rate, rides.distance_km, rides.calories, rides.status, rides.source,
                    routes.id, routes.name
             FROM rides JOIN riders ON riders.id = rides.rider_id
             LEFT JOIN routes ON routes.id = rides.route_id WHERE rides.id = ?1",
            [ride_id],
            |row| {
                Ok(Ride {
                    id: row.get(0)?,
                    rider_id: row.get(1)?,
                    rider_name: row.get(2)?,
                    started_at: row.get(3)?,
                    ended_at: row.get(4)?,
                    duration_seconds: row.get(5)?,
                    average_power: row.get(6)?,
                    max_power: row.get(7)?,
                    average_cadence: row.get(8)?,
                    average_heart_rate: row.get(9)?,
                    distance_km: row.get(10)?,
                    calories: row.get(11)?,
                    status: row.get(12)?,
                    source: row.get(13)?,
                    route_id: row.get(14)?,
                    route_name: row.get(15)?,
                })
            },
        )
        .map_err(|error| db_error("Could not load completed ride", error))
}

#[tauri::command]
fn record_metrics(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, KioskState>,
    metrics: RideMetrics,
) -> Result<(), String> {
    authorize_window(window.label(), CommandAccess::Control)?;
    validate_metrics(&metrics)?;
    let active_ride = state
        .active_ride
        .lock()
        .map_err(|error| format!("Could not check active ride: {error}"))?;
    let ride_id = active_ride.ok_or("No ride is active.")?;
    let connection = state
        .database
        .lock()
        .map_err(|error| format!("Could not access telemetry storage: {error}"))?;
    let latest_elapsed = connection
        .query_row(
            "SELECT MAX(elapsed_seconds) FROM telemetry WHERE ride_id = ?1",
            [ride_id],
            |row| row.get::<_, Option<u32>>(0),
        )
        .map_err(|error| db_error("Could not check telemetry sequence", error))?;
    if latest_elapsed.is_some_and(|elapsed| metrics.elapsed_seconds <= elapsed) {
        return Err("Telemetry elapsed time must increase for each accepted sample.".into());
    }
    connection
        .execute(
            "INSERT INTO telemetry
             (ride_id, elapsed_seconds, power, cadence, speed_kph, heart_rate, grade)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(ride_id, elapsed_seconds) DO UPDATE SET
                 power = excluded.power, cadence = excluded.cadence,
                 speed_kph = excluded.speed_kph, heart_rate = excluded.heart_rate,
                 grade = excluded.grade",
            params![
                ride_id,
                metrics.elapsed_seconds,
                metrics.power,
                metrics.cadence,
                metrics.speed_kph,
                metrics.heart_rate,
                metrics.grade
            ],
        )
        .map_err(|error| db_error("Could not record telemetry", error))?;
    drop(connection);
    drop(active_ride);
    app.emit("ride-metrics", metrics)
        .map_err(|error| format!("Telemetry recorded but display notification failed: {error}"))
}

#[tauri::command]
fn end_ride(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, KioskState>,
) -> Result<Ride, String> {
    authorize_window(window.label(), CommandAccess::Control)?;
    let mut active_ride = state
        .active_ride
        .lock()
        .map_err(|error| format!("Could not check active ride: {error}"))?;
    let ride_id = active_ride.ok_or("No ride is active.")?;
    let ended_at = unix_time()?;
    let connection = state
        .database
        .lock()
        .map_err(|error| format!("Could not access ride storage: {error}"))?;
    let ride = finish_ride(&connection, ride_id, ended_at)?;
    *active_ride = None;
    drop(connection);
    app.emit_to("display", "ride-ended", ())
        .map_err(|error| format!("Ride completed but display notification failed: {error}"))?;
    app.emit_to("vr", "ride-ended", ())
        .map_err(|error| format!("Ride completed but display notification failed: {error}"))?;
    app.emit_to("manager", "ride-ended", ())
        .map_err(|error| format!("Ride completed but manager notification failed: {error}"))?;
    Ok(ride)
}

#[tauri::command]
fn list_rides(
    window: WebviewWindow,
    state: State<'_, KioskState>,
    limit: u32,
) -> Result<Vec<Ride>, String> {
    authorize_window(window.label(), CommandAccess::LocalRead)?;
    let limit = limit.clamp(1, 100);
    let connection = state
        .database
        .lock()
        .map_err(|error| format!("Could not access ride storage: {error}"))?;
    let mut statement = connection
        .prepare(
            "SELECT rides.id, rides.rider_id, riders.name, rides.started_at, rides.ended_at,
                    rides.duration_seconds, rides.average_power, rides.max_power, rides.average_cadence,
                    rides.average_heart_rate, rides.distance_km, rides.calories, rides.status, rides.source,
                    routes.id, routes.name
             FROM rides JOIN riders ON riders.id = rides.rider_id
             LEFT JOIN routes ON routes.id = rides.route_id
             ORDER BY started_at DESC LIMIT ?1",
        )
        .map_err(|error| db_error("Could not prepare ride history", error))?;
    let rides = statement
        .query_map([limit], |row| {
            Ok(Ride {
                id: row.get(0)?,
                rider_id: row.get(1)?,
                rider_name: row.get(2)?,
                started_at: row.get(3)?,
                ended_at: row.get(4)?,
                duration_seconds: row.get(5)?,
                average_power: row.get(6)?,
                max_power: row.get(7)?,
                average_cadence: row.get(8)?,
                average_heart_rate: row.get(9)?,
                distance_km: row.get(10)?,
                calories: row.get(11)?,
                status: row.get(12)?,
                source: row.get(13)?,
                route_id: row.get(14)?,
                route_name: row.get(15)?,
            })
        })
        .map_err(|error| db_error("Could not read ride history", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| db_error("Could not read ride history", error))?;
    Ok(rides)
}

#[tauri::command]
fn get_leaderboard(
    window: WebviewWindow,
    state: State<'_, KioskState>,
) -> Result<Vec<LeaderboardEntry>, String> {
    authorize_window(window.label(), CommandAccess::LocalRead)?;
    let connection = state
        .database
        .lock()
        .map_err(|error| format!("Could not access leaderboard storage: {error}"))?;
    let mut statement = connection
        .prepare(
            "SELECT riders.id, riders.name, COUNT(rides.id),
                    COALESCE(SUM(rides.distance_km), 0), COALESCE(MAX(rides.max_power), 0)
             FROM riders LEFT JOIN rides ON rides.rider_id = riders.id AND rides.status = 'completed'
             WHERE riders.locked = 0
             GROUP BY riders.id ORDER BY SUM(rides.distance_km) DESC, riders.name COLLATE NOCASE",
        )
        .map_err(|error| db_error("Could not prepare leaderboard", error))?;
    let entries = statement
        .query_map([], |row| {
            Ok(LeaderboardEntry {
                rider_id: row.get(0)?,
                rider_name: row.get(1)?,
                rides: row.get(2)?,
                total_distance_km: row.get(3)?,
                best_power: row.get(4)?,
            })
        })
        .map_err(|error| db_error("Could not read leaderboard", error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| db_error("Could not read leaderboard", error))?;
    Ok(entries)
}

#[tauri::command]
fn get_latest_metrics(
    window: WebviewWindow,
    state: State<'_, KioskState>,
) -> Result<Option<RideMetrics>, String> {
    authorize_window(window.label(), CommandAccess::TelemetryRead)?;
    let active_ride = state
        .active_ride
        .lock()
        .map_err(|error| format!("Could not check active ride: {error}"))?;
    let connection = state
        .database
        .lock()
        .map_err(|error| format!("Could not access telemetry storage: {error}"))?;
    let ride_id = match *active_ride {
        Some(ride_id) => Some(ride_id),
        None => connection
            .query_row(
                "SELECT id FROM rides WHERE status = 'active' ORDER BY started_at DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| db_error("Could not find the active ride", error))?,
    };
    let Some(ride_id) = ride_id else {
        return Ok(None);
    };
    connection
        .query_row(
            "SELECT power, cadence, speed_kph, heart_rate, grade, elapsed_seconds
             FROM telemetry WHERE ride_id = ?1 ORDER BY elapsed_seconds DESC LIMIT 1",
            [ride_id],
            |row| {
                Ok(RideMetrics {
                    power: row.get(0)?,
                    cadence: row.get(1)?,
                    speed_kph: row.get(2)?,
                    heart_rate: row.get(3)?,
                    grade: row.get(4)?,
                    elapsed_seconds: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|error| db_error("Could not read the latest telemetry", error))
}

#[tauri::command]
fn open_manager_console(window: WebviewWindow) -> Result<(), String> {
    authorize_window(window.label(), CommandAccess::ControlOrManager)?;
    let current_exe =
        std::env::current_exe().map_err(|error| format!("Could not locate WorkFit: {error}"))?;
    let manager_exe = std::env::var_os("WORKFIT_MANAGER_EXECUTABLE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            current_exe.with_file_name(if cfg!(windows) {
                "workfit-manager.exe"
            } else {
                "workfit-manager"
            })
        });
    if manager_exe.is_file() {
        return Command::new(&manager_exe)
            .spawn()
            .map(|_| ())
            .map_err(|error| {
                format!(
                    "Could not launch WorkFit Manager at {}: {error}.",
                    manager_exe.display()
                )
            });
    }

    if cfg!(debug_assertions) {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        return Command::new("cargo")
            .args(["run", "--manifest-path"])
            .arg(&manifest)
            .args(["--bin", "workfit-manager"])
            .current_dir(manifest.parent().unwrap_or_else(|| Path::new(".")))
            .spawn()
            .map(|_| ())
            .map_err(|error| {
                format!(
                    "Could not start the WorkFit Manager development target with Cargo: {error}. \
                     Build it with `npm run manager:build` or set WORKFIT_MANAGER_EXECUTABLE."
                )
            });
    }

    Err(format!(
        "WorkFit Manager was not found at {}. Build and install the separate Manager app, or set WORKFIT_MANAGER_EXECUTABLE to its path.",
        manager_exe.display()
    ))
}

#[tauri::command]
fn open_vr_companion(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    authorize_window(window.label(), CommandAccess::ControlOrManager)?;
    open_app_window(&app, "vr", "vr.html", "WorkFit VR Companion")
        .map_err(|error| format!("Could not open the VR companion: {error}"))
}

#[tauri::command]
fn exit_workfit(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    authorize_window(window.label(), CommandAccess::Control)?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn open_ride_display(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, KioskState>,
) -> Result<(), String> {
    authorize_window(window.label(), CommandAccess::Control)?;
    require_settings_unlocked(window.label(), &state)?;
    open_secondary_display(&app).map_err(|error| format!("Could not open ride display: {error}"))
}

#[tauri::command]
fn close_ride_display(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, KioskState>,
) -> Result<(), String> {
    authorize_window(window.label(), CommandAccess::Control)?;
    require_settings_unlocked(window.label(), &state)?;
    if let Some(display) = app.get_webview_window("display") {
        display
            .close()
            .map_err(|error| format!("Could not close ride display: {error}"))?;
    }
    Ok(())
}

fn open_app_window(
    app: &AppHandle,
    label: &'static str,
    page: &'static str,
    title: &'static str,
) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(label) {
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(page.into()))
        .title(title)
        .inner_size(1280.0, 800.0)
        .build()?;
    Ok(())
}

fn open_secondary_display(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("display") {
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }

    let monitors = app.available_monitors()?;
    let primary = app.primary_monitor()?;
    let secondary = monitors.iter().find(|monitor| {
        primary
            .as_ref()
            .is_none_or(|primary| !same_monitor(primary, monitor))
    });

    let (position, width, height) = if let Some(monitor) = secondary {
        let position = monitor.position().to_owned();
        let size = monitor.size();
        (position, size.width, size.height)
    } else {
        primary
            .as_ref()
            .map_or((PhysicalPosition::new(0, 0), 1280, 800), |monitor| {
                let size = monitor.size();
                (
                    monitor.position().to_owned(),
                    size.width.min(1280),
                    size.height.min(800),
                )
            })
    };
    let window = WebviewWindowBuilder::new(app, "display", WebviewUrl::App("display.html".into()))
        .title("WorkFit Ride Display")
        .inner_size(width as f64, height as f64)
        .build()?;
    window.set_position(position)?;
    Ok(())
}

pub fn run() -> Result<(), tauri::Error> {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let database = initialize_database(&data_dir.join("workfit.sqlite"))
                .map_err(std::io::Error::other)?;
            app.manage(KioskState {
                database: Mutex::new(database),
                active_ride: Mutex::new(None),
                settings_unlocked: Mutex::new(false),
                bluetooth_heart_rate: Mutex::new(None),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_idle_message,
            set_idle_message,
            get_kiosk_status,
            list_riders,
            create_rider,
            set_rider_locked,
            set_kiosk_lock,
            start_ride,
            record_metrics,
            end_ride,
            list_rides,
            get_leaderboard,
            get_latest_metrics,
            save_route,
            list_routes,
            open_manager_console,
            open_vr_companion,
            exit_workfit,
            open_ride_display,
            close_ride_display,
            scan_bluetooth_heart_rate_devices,
            get_connected_bluetooth_heart_rate,
            connect_bluetooth_heart_rate,
            disconnect_bluetooth_heart_rate,
            settings_pin_is_set,
            unlock_settings,
            lock_settings,
            update_settings_pin
        ])
        .run(tauri::generate_context!())
        .map_err(|error| {
            eprintln!("WorkFit failed to start: {error}");
            error
        })
}

pub fn run_manager() -> Result<(), tauri::Error> {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let database = open_manager_database(&data_dir.join("workfit.sqlite"))
                .map_err(std::io::Error::other)?;
            app.manage(KioskState {
                database: Mutex::new(database),
                active_ride: Mutex::new(None),
                settings_unlocked: Mutex::new(false),
                bluetooth_heart_rate: Mutex::new(None),
            });
            if let Some(manager) = app.get_webview_window("manager") {
                if let Some(primary) = app.primary_monitor()? {
                    let position = primary.position();
                    manager.set_position(PhysicalPosition::new(position.x, position.y))?;
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_kiosk_status,
            list_riders,
            set_rider_locked,
            set_kiosk_lock,
            list_rides,
            get_leaderboard,
            get_latest_metrics,
            set_idle_message
        ])
        .run(tauri::generate_context!("tauri.manager.conf.json"))
        .map_err(|error| {
            eprintln!("WorkFit Manager failed to start: {error}");
            error
        })
}

#[cfg(test)]
mod tests {
    use super::estimate_calories;
    use super::validate_idle_message;
    use super::{authorize_window, CommandAccess};
    use super::{finish_ride, initialize_schema, validate_route, RoutePoint};
    use super::{validate_metrics, RideMetrics};
    use rusqlite::Connection;

    #[test]
    fn idle_message_is_trimmed_and_limited_by_characters() {
        assert_eq!(
            validate_idle_message("  Ready to ride  ".into()).as_deref(),
            Ok("Ready to ride")
        );
        assert!(validate_idle_message("  ".into()).is_err());
        assert!(validate_idle_message("x".repeat(121)).is_err());
        assert!(validate_idle_message("é".repeat(120)).is_ok());
    }

    #[test]
    fn database_migrations_enable_profiles_sessions_routes_and_settings() {
        let connection = Connection::open_in_memory().expect("in-memory sqlite should open");
        initialize_schema(&connection).expect("schema should initialize");
        let tables = connection
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .expect("schema query should prepare")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("schema query should run")
            .collect::<Result<Vec<_>, _>>()
            .expect("schema should be readable");
        assert!(tables.contains(&"riders".to_owned()));
        assert!(tables.contains(&"rides".to_owned()));
        assert!(tables.contains(&"telemetry".to_owned()));
        assert!(tables.contains(&"routes".to_owned()));
        assert!(tables.contains(&"settings".to_owned()));
        let idle_message = connection
            .query_row(
                "SELECT value FROM settings WHERE key = 'idle_message'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("default idle message should be stored");
        assert_eq!(idle_message, "Tap the primary screen to start your ride");
    }

    #[test]
    fn database_migration_upgrades_existing_rides_and_recovers_interrupted_workouts() {
        let connection = Connection::open_in_memory().expect("in-memory sqlite should open");
        connection
            .execute_batch(
                "CREATE TABLE riders (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE,
                    locked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
                 CREATE TABLE rides (
                    id INTEGER PRIMARY KEY, rider_id INTEGER NOT NULL, started_at INTEGER NOT NULL,
                    ended_at INTEGER, duration_seconds INTEGER NOT NULL DEFAULT 0,
                    average_power REAL NOT NULL DEFAULT 0, max_power INTEGER NOT NULL DEFAULT 0,
                    average_cadence REAL NOT NULL DEFAULT 0, average_heart_rate REAL NOT NULL DEFAULT 0,
                    distance_km REAL NOT NULL DEFAULT 0, calories INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'active');
                 INSERT INTO riders (id, name, created_at) VALUES (1, 'Alex', 1);
                 INSERT INTO rides (id, rider_id, started_at) VALUES (1, 1, 1);",
            )
            .expect("legacy schema should be created");
        initialize_schema(&connection).expect("legacy database should migrate");
        let (status, source, ended_at): (String, String, Option<i64>) = connection
            .query_row(
                "SELECT status, source, ended_at FROM rides WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("legacy ride should remain readable");
        assert_eq!(status, "interrupted");
        assert_eq!(source, "device");
        assert!(ended_at.is_some());
    }

    #[test]
    fn completed_ride_persists_accurate_summary_and_route_reference() {
        let connection = Connection::open_in_memory().expect("in-memory sqlite should open");
        initialize_schema(&connection).expect("schema should initialize");
        connection
            .execute(
                "INSERT INTO riders (name, created_at) VALUES ('Alex', 100)",
                [],
            )
            .expect("rider should insert");
        let rider_id = connection.last_insert_rowid();
        connection
            .execute(
                "INSERT INTO routes (name, distance_km, elevation_gain_m, points_json, created_at)
                 VALUES ('Hill', 1.0, 20.0, '[]', 100)",
                [],
            )
            .expect("route should insert");
        let route_id = connection.last_insert_rowid();
        connection
            .execute(
                "INSERT INTO rides (rider_id, started_at, source, route_id)
                 VALUES (?1, 100, 'demo', ?2)",
                rusqlite::params![rider_id, route_id],
            )
            .expect("ride should insert");
        let ride_id = connection.last_insert_rowid();
        for elapsed in 1..=60 {
            connection
                .execute(
                    "INSERT INTO telemetry
                     (ride_id, elapsed_seconds, power, cadence, speed_kph, heart_rate, grade)
                     VALUES (?1, ?2, 200, 90, 36, 140, 2)",
                    rusqlite::params![ride_id, elapsed],
                )
                .expect("sample should insert");
        }

        let ride = finish_ride(&connection, ride_id, 160).expect("ride should complete");
        assert_eq!(ride.status, "completed");
        assert_eq!(ride.rider_name, "Alex");
        assert_eq!(ride.duration_seconds, 60);
        assert_eq!(ride.average_power, 200.0);
        assert_eq!(ride.max_power, 200);
        assert_eq!(ride.average_heart_rate, 140.0);
        assert!((ride.distance_km - 0.6).abs() < 0.000_001);
        assert_eq!(ride.calories, 12);
        assert_eq!(ride.route_id, Some(route_id));
        assert_eq!(ride.route_name.as_deref(), Some("Hill"));
    }

    #[test]
    fn routes_validate_points_and_calculate_distance_and_climb() {
        let points = vec![
            RoutePoint {
                latitude: 51.5,
                longitude: -0.1,
                elevation_m: 10.0,
            },
            RoutePoint {
                latitude: 51.501,
                longitude: -0.1,
                elevation_m: 25.0,
            },
        ];
        let (_, distance_km, climb, _) =
            validate_route("Loop".into(), points.clone()).expect("valid route");
        assert!(distance_km > 0.1 && distance_km < 0.2);
        assert_eq!(climb, 15.0);
        assert!(validate_route(" ".into(), points.clone()).is_err());
        let mut invalid = points;
        invalid[0].latitude = f64::NAN;
        assert!(validate_route("Loop".into(), invalid).is_err());
    }

    #[test]
    fn telemetry_requires_finite_bounded_and_increasing_time_values() {
        let valid = RideMetrics {
            power: 200,
            cadence: 90,
            speed_kph: 32.5,
            heart_rate: 140,
            grade: 3.0,
            elapsed_seconds: 1,
        };
        assert!(validate_metrics(&valid).is_ok());
        assert!(validate_metrics(&RideMetrics {
            speed_kph: f64::NAN,
            ..valid.clone()
        })
        .is_err());
        assert!(validate_metrics(&RideMetrics {
            elapsed_seconds: 0,
            ..valid
        })
        .is_err());
    }

    #[test]
    fn calorie_estimate_uses_mechanical_energy_and_cycling_efficiency() {
        assert_eq!(estimate_calories(200.0 * 3600.0), 717);
        assert_eq!(estimate_calories(-10.0), 0);
    }

    #[test]
    fn vr_window_cannot_invoke_mutating_command_roles() {
        assert!(authorize_window("vr", CommandAccess::Control).is_err());
        assert!(authorize_window("vr", CommandAccess::Manager).is_err());
        assert!(authorize_window("vr", CommandAccess::ControlOrManager).is_err());
        assert!(authorize_window("manager", CommandAccess::Manager).is_ok());
        assert!(authorize_window("control", CommandAccess::Control).is_ok());
        assert!(authorize_window("vr", CommandAccess::LocalRead).is_err());
        assert!(authorize_window("vr", CommandAccess::DisplayRead).is_err());
        assert!(authorize_window("vr", CommandAccess::TelemetryRead).is_ok());
        assert!(authorize_window("display", CommandAccess::DisplayRead).is_ok());
    }
}
