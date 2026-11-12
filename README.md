# GESTURE TECH LAB

Interactive exhibition UI for turning MPU6050 motion into safe virtual experiences.

## Current build

- React + TypeScript + Vite frontend
- Responsive dark robotics-lab interface
- Overview, project lab, MotionSync, CrashGuard, Robot Car, JumpDino and System views
- Hardware-only telemetry: disconnected until a validated Arduino packet arrives
- Browser-only virtual visualisations; no physical robot is required
- No fabricated values are shown with a `LIVE` label

## Run locally

```powershell
npm install
npm run dev
```

Validate a production bundle with `npm run build`.

The validated serial bridge lives in `backend/`:

```powershell
cd backend
npm install
npm run build
npm start
```

It binds to `0.0.0.0:8787`, exposes `/health`, `/ports`, and `/connect`, validates newline-delimited hardware JSON with Zod, and broadcasts only validated `sensor:update` events through Socket.IO. The System screen scans available serial ports and connects the selected Arduino at 115200 baud.

## Hardware boundary

The UI never generates replacement readings. It stays disconnected until the serial bridge receives a valid Arduino packet. Each exhibition sketch can be uploaded separately from Arduino IDE, but every sketch must use the shared newline-delimited JSON envelope and set its own `module` value. The UI filters packets by the currently selected exhibition route. The bridge expects JSON such as:

```json
{
  "deviceId": "motion-01",
  "module": "robot_arm",
  "type": "sensor:update",
  "sequence": 42,
  "timestamp": 1730000000000,
  "source": "hardware",
  "accel": { "x": 0.01, "y": -0.02, "z": 0.98 },
  "gyro": { "x": 1.2, "y": -0.6, "z": 0.4 }
}
```

Supported module values are `accident_alert`, `robot_arm`, `robot_car`, `gesture_world`, and `analytics`. Upload the matching sketch in Arduino IDE, close Serial Monitor, restart/connect the bridge if needed, then open the matching route in the UI. The bridge preserves the distinction between `hardware` and `disconnected`; a connection failure never falls back to generated values.

MotionSync is displayed as a hand, not a robot arm. The Processing sketch's `roll,pitch,yaw` CSV output is supported: in System, select the serial port, choose MotionSync, choose `roll,pitch,yaw CSV`, and connect. The bridge converts those three live angles into the normalized MotionSync event without requiring Processing. Do not run Processing and the bridge against the same COM port simultaneously; only one application can own the serial port.

An upload-ready ESP32 sketch is provided at `firmware/motion_sync_hand.ino`. Install the `MPU6050_light` Arduino library, select ESP32 Dev Module and the detected COM port, upload it while the sensor is still during calibration, close Serial Monitor, then connect it from System using MotionSync and `JSON envelope`. It sends acceleration X/Y/Z, gyroscope X/Y/Z, and orientation roll/pitch/yaw together.

For a dashboard-compatible stream, use `firmware/mpu6050_dashboard_csv.ino`. It uses `Wire` and `MPU6050_light`, reports an explicit I2C failure in setup, calibrates while still, and prints newline-delimited JSON every 50 ms with acceleration in m/s², gyro in °/s, and roll/pitch/yaw. Select `JSON envelope` in System; the bridge accepts the complete `sensor:update` envelope directly.

For CrashGuard values, orientation, gyro, and alerts, use `firmware/crash_guard_live.ino`. It sends validated JSON containing acceleration, gyroscope, orientation, and an optional accident alert. Select CrashGuard with the `JSON envelope` protocol in System.

Important: the bridge cannot derive gyro or yaw from a packet that contains only `Accel: 1.18`. If MotionSync shows `ARM // CONNECTED, UPLOAD MOTIONSYNC JSON`, the board is connected but still running the older acceleration-only sketch. Upload `motion_sync_hand.ino`, then select MotionSync + `JSON envelope` and reconnect.

MotionSync has an explicit fallback for exhibition setup: when a live `robot_arm` packet has no orientation, the hand may show `SIMULATED FROM LIVE Z ACCELERATION`. This is visibly labeled `SIMULATION` and is never presented as live orientation. Upload a firmware sketch that sends orientation to switch back to real hand rotation.

In that same explicitly labeled simulation state, displayed X/Y acceleration values are varied near the live Z magnitude for a visible demonstration. Hardware packets and real orientation remain unchanged.

Robot Car uses the same explicit fallback when its live packet has no orientation: the rover derives a visibly labeled simulated tilt command from the live Z acceleration, while real orientation takes priority whenever present.

In Robot Car simulation, displayed X/Y acceleration, gyro X/Y/Z, and orientation roll/pitch/yaw are deterministic functions of the live Z axis. A stable 1g Z reading produces stable zero-offset orientation and gyro values; movement changes them. The source badge remains `SIMULATION`; these values are not written back as hardware telemetry.

JumpDino is a live dino runner. Movement intensity is shown in the HUD, and a jerk spike triggers the dino jump. Gyroscope and orientation are not used by this game. JumpDino uses COM5 only.

Other projects continue to use the single-port connection from System.

## Routes

`/` overview · `/lab` project lab · `/motion-sync` arm · `/crash-guard` CrashGuard · `/robo-drive` Robot Car · `/gesture-space` JumpDino · `/system` device management

Robot Car uses the `robot_car` module. The firmware sends acceleration X/Y/Z, gyroscope X/Y/Z, orientation roll/pitch/yaw, and a direction command. The UI maps pitch to `UP`/`DOWN` and roll to `LEFT`/`RIGHT`, with an acceleration fallback when orientation is temporarily near zero; a reported `NONE` does not prevent the UI from recalculating the command. The selected project must be Running for its visual movement to update.
