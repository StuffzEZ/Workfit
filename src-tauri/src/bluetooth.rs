use btleplug::{
    api::{Central, CharPropFlags, Manager as _, Peripheral as _, ScanFilter},
    platform::{Manager, Peripheral},
};
use futures_util::StreamExt;
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;
use uuid::Uuid;

const HEART_RATE_SERVICE: Uuid = Uuid::from_u128(0x0000180d_0000_1000_8000_00805f9b34fb);
const HEART_RATE_MEASUREMENT: Uuid = Uuid::from_u128(0x00002a37_0000_1000_8000_00805f9b34fb);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartRateDevice {
    pub id: String,
    pub name: String,
    pub rssi: Option<i16>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedHeartRateDevice {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HeartRateSample {
    device_id: String,
    device_name: String,
    bpm: u16,
}

pub struct HeartRateSession {
    device: ConnectedHeartRateDevice,
    peripheral: Peripheral,
    characteristic: btleplug::api::Characteristic,
    stop: watch::Sender<bool>,
    connected: Arc<AtomicBool>,
}

pub async fn scan_heart_rate_devices() -> Result<Vec<HeartRateDevice>, String> {
    let manager = Manager::new()
        .await
        .map_err(|error| format!("Could not access a Bluetooth LE adapter: {error}"))?;
    let adapters = manager
        .adapters()
        .await
        .map_err(|error| format!("Could not list Bluetooth LE adapters: {error}"))?;
    let adapter = adapters
        .into_iter()
        .next()
        .ok_or("No Bluetooth LE adapter is available.")?;

    adapter
        .start_scan(ScanFilter {
            services: vec![HEART_RATE_SERVICE],
        })
        .await
        .map_err(|error| format!("Could not scan for Bluetooth heart-rate sensors: {error}"))?;
    tokio::time::sleep(Duration::from_secs(4)).await;
    let peripherals = adapter
        .peripherals()
        .await
        .map_err(|error| format!("Could not read Bluetooth scan results: {error}"))?;
    adapter
        .stop_scan()
        .await
        .map_err(|error| format!("Could not stop the Bluetooth scan: {error}"))?;

    let mut devices = Vec::new();
    for peripheral in peripherals {
        let Some(properties) = peripheral
            .properties()
            .await
            .map_err(|error| format!("Could not read a Bluetooth device: {error}"))?
        else {
            continue;
        };
        if !properties.services.contains(&HEART_RATE_SERVICE) {
            continue;
        }
        let id = peripheral.id().to_string();
        devices.push(HeartRateDevice {
            name: properties
                .local_name
                .or(properties.advertisement_name)
                .unwrap_or_else(|| format!("Heart-rate sensor {id}")),
            id,
            rssi: properties.rssi,
        });
    }
    devices.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(devices)
}

pub async fn connect_heart_rate(
    app: AppHandle,
    sessions: &std::sync::Mutex<Option<HeartRateSession>>,
    device_id: String,
) -> Result<String, String> {
    let stale_session = {
        let mut active = sessions
            .lock()
            .map_err(|error| format!("Could not access Bluetooth connection state: {error}"))?;
        if active
            .as_ref()
            .is_some_and(|session| session.connected.load(Ordering::Acquire))
        {
            return Err(
                "Disconnect the current Bluetooth sensor before connecting another.".into(),
            );
        }
        active.take()
    };
    if let Some(session) = stale_session {
        let _ = session.stop.send(true);
    }

    let manager = Manager::new()
        .await
        .map_err(|error| format!("Could not access a Bluetooth LE adapter: {error}"))?;
    let adapters = manager
        .adapters()
        .await
        .map_err(|error| format!("Could not list Bluetooth LE adapters: {error}"))?;
    let adapter = adapters
        .into_iter()
        .next()
        .ok_or("No Bluetooth LE adapter is available.")?;
    adapter
        .start_scan(ScanFilter {
            services: vec![HEART_RATE_SERVICE],
        })
        .await
        .map_err(|error| format!("Could not scan for Bluetooth heart-rate sensors: {error}"))?;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let peripherals = adapter
        .peripherals()
        .await
        .map_err(|error| format!("Could not read Bluetooth scan results: {error}"))?;
    adapter
        .stop_scan()
        .await
        .map_err(|error| format!("Could not stop the Bluetooth scan: {error}"))?;
    let peripheral = peripherals
        .into_iter()
        .find(|candidate| candidate.id().to_string() == device_id)
        .ok_or("The selected Bluetooth heart-rate sensor is no longer in range.")?;
    let device_name = peripheral
        .properties()
        .await
        .map_err(|error| format!("Could not read Bluetooth device details: {error}"))?
        .and_then(|properties| properties.local_name.or(properties.advertisement_name))
        .unwrap_or_else(|| format!("Heart-rate sensor {device_id}"));

    peripheral.connect().await.map_err(|error| {
        format!("Could not connect to the Bluetooth heart-rate sensor: {error}")
    })?;
    if let Err(error) = peripheral.discover_services().await {
        let _ = peripheral.disconnect().await;
        return Err(format!(
            "Could not discover Bluetooth sensor services: {error}"
        ));
    }
    let Some(characteristic) = peripheral
        .characteristics()
        .into_iter()
        .find(|characteristic| {
            characteristic.uuid == HEART_RATE_MEASUREMENT
                && (characteristic.properties.contains(CharPropFlags::NOTIFY)
                    || characteristic.properties.contains(CharPropFlags::INDICATE))
        })
    else {
        let _ = peripheral.disconnect().await;
        return Err(
            "The selected device does not expose a standard Bluetooth heart-rate measurement."
                .into(),
        );
    };
    if let Err(error) = peripheral.subscribe(&characteristic).await {
        let _ = peripheral.disconnect().await;
        return Err(format!(
            "Could not subscribe to Bluetooth heart-rate updates: {error}"
        ));
    }
    let mut notifications = match peripheral.notifications().await {
        Ok(notifications) => notifications,
        Err(error) => {
            let _ = peripheral.unsubscribe(&characteristic).await;
            let _ = peripheral.disconnect().await;
            return Err(format!(
                "Could not read Bluetooth heart-rate updates: {error}"
            ));
        }
    };
    let (stop, mut stop_requested) = watch::channel(false);
    let connected = Arc::new(AtomicBool::new(true));
    let task_connected = Arc::clone(&connected);
    let event_app = app.clone();
    let event_device_id = device_id.clone();
    let event_device_name = device_name.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let notification = tokio::select! {
                changed = stop_requested.changed() => {
                    if changed.is_err() || *stop_requested.borrow() {
                        break;
                    }
                    continue;
                }
                notification = notifications.next() => {
                    let Some(notification) = notification else {
                        break;
                    };
                    notification
                }
            };
            if notification.uuid != HEART_RATE_MEASUREMENT {
                continue;
            }
            if let Some(bpm) = parse_heart_rate(&notification.value) {
                if let Err(error) = event_app.emit(
                    "bluetooth-heart-rate",
                    HeartRateSample {
                        device_id: event_device_id.clone(),
                        device_name: event_device_name.clone(),
                        bpm,
                    },
                ) {
                    eprintln!("Could not publish Bluetooth heart-rate update: {error}");
                    break;
                }
            }
        }
        task_connected.store(false, Ordering::Release);
        if let Err(error) = event_app.emit("bluetooth-disconnected", ()) {
            eprintln!("Could not publish Bluetooth disconnection: {error}");
        }
    });
    let inserted = {
        let mut active = sessions
            .lock()
            .map_err(|error| format!("Could not access Bluetooth connection state: {error}"))?;
        if active.is_some() {
            false
        } else {
            *active = Some(HeartRateSession {
                device: ConnectedHeartRateDevice {
                    id: device_id.clone(),
                    name: device_name.clone(),
                },
                peripheral: peripheral.clone(),
                characteristic: characteristic.clone(),
                stop: stop.clone(),
                connected,
            });
            true
        }
    };
    if !inserted {
        let _ = stop.send(true);
        let _ = peripheral.unsubscribe(&characteristic).await;
        let _ = peripheral.disconnect().await;
        return Err("Another Bluetooth sensor connected while this request was running.".into());
    }
    Ok(device_name)
}

pub async fn disconnect_heart_rate(
    sessions: &std::sync::Mutex<Option<HeartRateSession>>,
) -> Result<(), String> {
    let Some(session) = sessions
        .lock()
        .map_err(|error| format!("Could not access Bluetooth connection state: {error}"))?
        .take()
    else {
        return Ok(());
    };
    let _ = session.stop.send(true);
    if !session.connected.load(Ordering::Acquire) {
        return Ok(());
    }
    let unsubscribe_result = session
        .peripheral
        .unsubscribe(&session.characteristic)
        .await
        .map_err(|error| format!("Could not unsubscribe from the Bluetooth sensor: {error}"));
    let disconnect_result = session
        .peripheral
        .disconnect()
        .await
        .map_err(|error| format!("Could not disconnect the Bluetooth sensor: {error}"));
    unsubscribe_result?;
    disconnect_result
}

pub fn connected_heart_rate(
    sessions: &std::sync::Mutex<Option<HeartRateSession>>,
) -> Result<Option<ConnectedHeartRateDevice>, String> {
    let mut active = sessions
        .lock()
        .map_err(|error| format!("Could not access Bluetooth connection state: {error}"))?;
    if active
        .as_ref()
        .is_some_and(|session| !session.connected.load(Ordering::Acquire))
    {
        active.take();
    }
    Ok(active.as_ref().map(|session| session.device.clone()))
}

fn parse_heart_rate(value: &[u8]) -> Option<u16> {
    let flags = *value.first()?;
    let bpm = if flags & 0x01 == 0 {
        u16::from(*value.get(1)?)
    } else {
        u16::from_le_bytes([*value.get(1)?, *value.get(2)?])
    };
    (1..=250).contains(&bpm).then_some(bpm)
}

#[cfg(test)]
mod tests {
    use super::parse_heart_rate;

    #[test]
    fn parses_standard_bluetooth_heart_rate_formats() {
        assert_eq!(parse_heart_rate(&[0x00, 147]), Some(147));
        assert_eq!(parse_heart_rate(&[0x01, 180, 0]), Some(180));
        assert_eq!(parse_heart_rate(&[0x01, 0x90, 0x00]), Some(144));
    }

    #[test]
    fn rejects_truncated_and_out_of_range_heart_rate_values() {
        assert_eq!(parse_heart_rate(&[]), None);
        assert_eq!(parse_heart_rate(&[0x00]), None);
        assert_eq!(parse_heart_rate(&[0x01, 180]), None);
        assert_eq!(parse_heart_rate(&[0x00, 0]), None);
        assert_eq!(parse_heart_rate(&[0x00, 251]), None);
    }
}
