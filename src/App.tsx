import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { io } from 'socket.io-client'
import './App.css'

type Route = { path: string; label: string; icon: string }
type SensorReading = {
  accel: [number, number, number]
  gyro: [number, number, number]
  orientation: [number, number, number]
  intensity: number
  jerk: number
  deviceId: string
  module: ExhibitionModule
  direction?: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'NONE'
  alert?: string
  hasOrientation: boolean
  hasGyro: boolean
  simulated: boolean
  displayAccel: [number, number, number]
  displayGyro: [number, number, number]
  displayOrientation: [number, number, number]
  sequence: number
  timestamp: number
  side?: 'left' | 'right'
}
type HardwareEvent = {
  deviceId: string
  module: ExhibitionModule
  sequence: number
  timestamp: number
  accel: { x: number; y: number; z: number }
  gyro: { x: number; y: number; z: number }
  orientation?: { x: number; y: number; z: number }
  direction?: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'NONE'
  alert?: string
  side?: 'left' | 'right'
}
type ExhibitionModule = 'accident_alert' | 'robot_arm' | 'robot_car' | 'gesture_world' | 'analytics'
type HardwareStatus = 'connected' | 'disconnected' | 'error' | 'invalid-data'
type HardwareSide = 'left' | 'right'
type SerialPortInfo = { path: string; manufacturer?: string; serialNumber?: string }
type SerialProtocol = 'auto' | 'json' | 'angles_csv' | 'labeled_csv' | 'direction_text' | 'accident_text'
type ActiveAlert = { message: string; module: ExhibitionModule; until: number }
type NeutralReading = { accel: [number, number, number]; orientation: [number, number, number] }
type MotorState = { direction: 'FORWARD' | 'BACKWARD' | 'STOP'; speed: number }
const DINO_ACCELERATION_THRESHOLD = 15
const DINO_ACCELERATION_RESET = 10
const DINO_JERK_THRESHOLD = 200
const DINO_JERK_RESET = 150

const bridgeUrl = import.meta.env.VITE_BRIDGE_URL ?? `http://${window.location.hostname}:8787`
const routes: Route[] = [
  { path: '/', label: 'Overview', icon: '⌂' }, { path: '/lab', label: 'Project Lab', icon: '◈' },
  { path: '/motion-sync', label: 'MotionSync', icon: '⌁' }, { path: '/crash-guard', label: 'CrashGuard', icon: '◇' },
  { path: '/robo-drive', label: 'Robot Car', icon: '▣' }, { path: '/gesture-space', label: 'JumpDino', icon: '✦' },
  { path: '/system', label: 'System', icon: '⚙' },
]
const projects = [
  { route: '/motion-sync', name: 'MotionSync', title: 'Gesture controlled arm', description: 'Translate real orientation into a virtual robotic arm.', tone: 'cyan', metric: '4 joints active' },
  { route: '/crash-guard', name: 'CrashGuard', title: 'CrashGuard', description: 'Explore motion thresholds in a safe virtual vehicle.', tone: 'orange', metric: 'Monitoring nominal' },
  { route: '/robo-drive', name: 'Robot Car', title: 'Gesture controlled robot car', description: 'Drive the robot car forward, backward, left, and right by tilting the MPU6050.', tone: 'blue', metric: 'Tilt steering ready' },
  { route: '/gesture-space', name: 'JumpDino', title: 'Acceleration + Jerk Dino', description: 'Jump the dino when acceleration and jerk both cross their thresholds.', tone: 'purple', metric: '15 m/s² + 200 m/s³ trigger' },
]
const moduleLabels: Record<ExhibitionModule, string> = {
  accident_alert: 'CrashGuard',
  robot_arm: 'MotionSync',
  robot_car: 'Robot Car',
  gesture_world: 'JumpDino',
  analytics: 'Motion Analytics',
}
const moduleForPath: Record<string, ExhibitionModule> = {
  '/motion-sync': 'robot_arm',
  '/crash-guard': 'accident_alert',
  '/robo-drive': 'robot_car',
  '/gesture-space': 'gesture_world',
}

function App() {
  const [path, setPath] = useState(window.location.pathname)
  const [reading, setReading] = useState<SensorReading | null>(null)
  const [readingsByModule, setReadingsByModule] = useState<Partial<Record<ExhibitionModule, SensorReading>>>({})
  const [arvrReadings, setArvrReadings] = useState<{ left: SensorReading | null; right: SensorReading | null }>({ left: null, right: null })
  const [history, setHistory] = useState<number[]>([])
  const [status, setStatus] = useState<HardwareStatus>('disconnected')
  const [statusMessage, setStatusMessage] = useState('Connect an Arduino from System')
  const [calibrated, setCalibrated] = useState(false)
  const [neutralByModule, setNeutralByModule] = useState<Partial<Record<ExhibitionModule, NeutralReading>>>({})
  const [activeAlert, setActiveAlert] = useState<ActiveAlert | null>(null)
  const [runningByModule, setRunningByModule] = useState<Record<ExhibitionModule, boolean>>({
    accident_alert: true,
    robot_arm: true,
    robot_car: true,
    gesture_world: true,
    analytics: true,
  })
  const activeModule = moduleForPath[path]
  const activeModuleRef = useRef(activeModule)
  const runningRef = useRef(runningByModule)
  const simulationZRef = useRef<Partial<Record<ExhibitionModule, number>>>({})
  const neutralByModuleRef = useRef<Partial<Record<ExhibitionModule, NeutralReading>>>({})
  const previousSensorRef = useRef<Partial<Record<string, { accel: [number, number, number]; timestamp: number }>>>({})
  useEffect(() => { activeModuleRef.current = activeModule }, [activeModule])
  useEffect(() => { runningRef.current = runningByModule }, [runningByModule])

  useEffect(() => {
    const socket = io(bridgeUrl, { autoConnect: true, reconnection: true })
    socket.on('sensor:update', (event: HardwareEvent) => {
      const accel: [number, number, number] = [event.accel.x, event.accel.y, event.accel.z]
      const gyro: [number, number, number] = [event.gyro.x, event.gyro.y, event.gyro.z]
      const hasOrientation = Boolean(event.orientation)
      const hasGyro = true
      const simulated = !event.orientation && (event.module === 'robot_arm' || event.module === 'robot_car')
      const filteredZ = simulated
        ? smoothSimulationZ(simulationZRef.current[event.module], accel[2], event.module === 'robot_car' ? 0.12 : 0.32)
        : accel[2]
      if (simulated) simulationZRef.current[event.module] = filteredZ
      const displayAccel: [number, number, number] = simulated ? simulatedAcceleration(filteredZ, event.module) : accel
      const orientation: [number, number, number] = event.orientation
        ? [event.orientation.x, event.orientation.y, event.orientation.z]
        : simulated
          ? simulatedOrientation(filteredZ, event.module)
          : [0, 0, 0]
      const displayOrientation: [number, number, number] = simulated ? simulatedOrientation(filteredZ, event.module) : orientation
      const displayGyro: [number, number, number] = simulated ? simulatedGyro(filteredZ, event.module) : gyro
      if (event.module === 'robot_car' && !neutralByModuleRef.current.robot_car) {
        const neutral = { accel: displayAccel, orientation: displayOrientation }
        neutralByModuleRef.current.robot_car = neutral
        setNeutralByModule((values) => ({ ...values, robot_car: neutral }))
      }
      const intensityAccel = simulated ? displayAccel : accel
      const intensityGyro = simulated ? displayGyro : gyro
      const accelerationInG = Math.sqrt(intensityAccel[0] ** 2 + intensityAccel[1] ** 2 + intensityAccel[2] ** 2) / 9.80665
      const intensity = Math.min(100, Math.round(accelerationInG * 35 + (event.module === 'gesture_world' ? 0 : Math.sqrt(intensityGyro[0] ** 2 + intensityGyro[1] ** 2 + intensityGyro[2] ** 2) * 0.8)))
      const sensorKey = `${event.module}:${event.side ?? 'single'}`
      const previous = previousSensorRef.current[sensorKey]
      const elapsedSeconds = previous ? Math.max(0.001, (event.timestamp - previous.timestamp) / 1000) : 0
      const accelerationScale = Math.max(...accel.map((value) => Math.abs(value))) <= 3 ? 9.80665 : 1
      const jerk = previous && elapsedSeconds > 0
        ? Math.sqrt((accel[0] - previous.accel[0]) ** 2 + (accel[1] - previous.accel[1]) ** 2 + (accel[2] - previous.accel[2]) ** 2) * accelerationScale / elapsedSeconds
        : 0
      previousSensorRef.current[sensorKey] = { accel, timestamp: event.timestamp }
      const next: SensorReading = { deviceId: event.deviceId, module: event.module, sequence: event.sequence, timestamp: event.timestamp, side: event.side, accel, gyro, orientation, intensity, jerk, direction: event.direction, alert: event.alert, hasOrientation, hasGyro, simulated, displayAccel, displayGyro, displayOrientation }
      setReadingsByModule((values) => ({ ...values, [event.module]: next }))
      if (event.module === 'gesture_world') setArvrReadings((values) => ({ ...values, [event.side ?? 'left']: next }))
      if (event.module === activeModuleRef.current && runningRef.current[event.module]) {
        setReading(next)
        setHistory((values) => [...values.slice(-15), intensity])
      }
      if (event.module === 'accident_alert' && runningRef.current.accident_alert && (event.alert || Math.abs(accel[2]) >= 2.5)) {
        setActiveAlert({ message: event.alert ?? `HIGH IMPACT DETECTED · ${Math.abs(accel[2]).toFixed(2)} G`, module: event.module, until: Date.now() + 10000 })
      }
      setStatus('connected')
      setStatusMessage(`Arduino ${event.deviceId} · sequence ${event.sequence}`)
    })
    socket.on('hardware:status', (event: { status: HardwareStatus; message?: string; side?: HardwareSide }) => {
      if (event.status === 'invalid-data') return
      setStatus(event.status)
      if (event.message) setStatusMessage(event.side ? `${event.side.toUpperCase()} AR/VR: ${event.message}` : event.message)
    })
    socket.on('hardware:connect', (event: { side?: HardwareSide }) => { setStatus('connected'); setStatusMessage(event.side ? `${event.side.toUpperCase()} AR/VR port connected` : 'Arduino connected') })
    socket.on('hardware:disconnect', (event: { side?: HardwareSide }) => { setStatus('disconnected'); setStatusMessage(event.side ? `${event.side.toUpperCase()} AR/VR port disconnected` : 'Arduino disconnected') })
    return () => { socket.disconnect() }
  }, [])

  useEffect(() => {
    if (!activeAlert) return
    const remaining = activeAlert.until - Date.now()
    const timer = window.setTimeout(() => setActiveAlert(null), Math.max(0, remaining))
    return () => window.clearTimeout(timer)
  }, [activeAlert])

  const navigate = (nextPath: string) => { window.history.pushState({}, '', nextPath); setPath(nextPath) }
  const current = routes.find((route) => route.path === path) ?? routes[0]
  const displayedReading = activeModule ? readingsByModule[activeModule] ?? null : reading
  const setProjectRunning = (module: ExhibitionModule, running: boolean) => setRunningByModule((values) => ({ ...values, [module]: running }))
  const page = path === '/' ? <Overview navigate={navigate} reading={reading} status={status} /> : path === '/lab' ? <Lab navigate={navigate} /> : path === '/analytics' ? <Analytics reading={displayedReading} history={history} /> : path === '/system' ? <System status={status} statusMessage={statusMessage} /> : <ProjectPage path={path} reading={displayedReading} arvrReadings={arvrReadings} neutral={activeModule ? neutralByModule[activeModule] : undefined} setNeutral={(neutral) => { if (!activeModule) return; neutralByModuleRef.current[activeModule] = neutral; setNeutralByModule((values) => ({ ...values, [activeModule]: neutral })) }} calibrated={calibrated} setCalibrated={setCalibrated} running={activeModule ? runningByModule[activeModule] : true} setRunning={(running) => activeModule && setProjectRunning(activeModule, running)} alert={activeAlert?.module === 'accident_alert' && path === '/crash-guard' ? activeAlert.message : undefined} />

  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => navigate('/')} aria-label="Go to overview"><span className="brand-mark">G</span><span><strong>GESTURE</strong><small>TECH LAB</small></span></button>
      <div className="sidebar-label">Workspace</div><nav>{routes.slice(0, 2).map((route) => <NavItem key={route.path} route={route} active={current.path === route.path} navigate={navigate} />)}</nav>
      <div className="sidebar-label">Virtual projects</div><nav>{routes.slice(2, 6).map((route) => <NavItem key={route.path} route={route} active={current.path === route.path} navigate={navigate} />)}</nav>
      <div className="sidebar-label">Insights</div><nav>{routes.slice(6).map((route) => <NavItem key={route.path} route={route} active={current.path === route.path} navigate={navigate} />)}</nav>
      <div className="sidebar-footer"><div className="mini-status"><span className={`pulse ${status === 'connected' ? '' : 'offline'}`} /> {status === 'connected' ? 'Arduino connected' : 'Waiting for Arduino'}</div><span className="version">v0.2 hardware build</span></div>
    </aside>
    <main className="main-content"><header className="topbar"><div className="crumb"><span>LAB /</span> {current.label}</div><div className="top-actions"><div className="module-chip">{activeModule ? moduleLabels[activeModule] : 'All modules'}</div><div className={`connection-badge ${status !== 'connected' ? 'offline' : ''}`}><span className="pulse" /> {status === 'connected' ? 'LIVE HARDWARE' : status.toUpperCase()}</div><div className="avatar">SD</div></div></header><div className="page-content">{page}</div></main>
  </div>
}

function NavItem({ route, active, navigate }: { route: Route; active: boolean; navigate: (path: string) => void }) {
  return <button className={`nav-item ${active ? 'active' : ''}`} onClick={() => navigate(route.path)}><span className="nav-icon">{route.icon}</span>{route.label}{active && <span className="nav-arrow">›</span>}</button>
}
function PageHeader({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: ReactNode }) {
  return <div className="page-header"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{children}</div>
}
function Overview({ navigate, reading, status }: { navigate: (path: string) => void; reading: SensorReading | null; status: HardwareStatus }) {
  const live = status === 'connected'
  return <><PageHeader eyebrow="CONTROL CENTER / 01" title="Welcome to the lab." description="Real motion. Virtual intelligence. Explore the intersection of physical sensors and digital worlds."><button className="primary-button" onClick={() => navigate('/system')}>{live ? 'Manage hardware' : 'Connect Arduino'} <span>→</span></button></PageHeader>
    <section className="hero-panel"><div className="hero-copy"><span className="live-kicker"><span className={`pulse ${live ? '' : 'offline'}`} /> {live ? 'LIVE HARDWARE STREAM' : 'HARDWARE NOT CONNECTED'}</span><h2>Turn movement<br />into <em>possibility.</em></h2><p>Connect an MPU6050 sensor to control immersive virtual experiences. Every value shown here comes from your Arduino.</p><button className="outline-button" onClick={() => navigate('/system')}>Configure Arduino <span>↗</span></button></div><div className="hero-visual"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="arm-visual"><div className="arm-joint base-joint" /><div className="arm-segment upper" /><div className="arm-joint joint-two" /><div className="arm-segment lower" /><div className="arm-joint joint-three" /><div className="gripper" /></div><div className="visual-tag tag-a">MPU6050 <small>{live ? 'LIVE INPUT' : 'WAITING'}</small></div><div className="visual-tag tag-b">VIRTUAL ARM <small>READY</small></div></div></section>
    <div className="section-heading"><div><span className="eyebrow">AT A GLANCE</span><h2>System overview</h2></div><span className="updated">{reading ? `Device ${reading.deviceId} · sequence ${reading.sequence}` : 'No hardware reading received'}</span></div>
    <div className="stat-grid"><Stat label="Sensor status" value={live ? 'Live' : 'Offline'} detail={live ? 'Arduino · MPU6050' : 'Connect from System'} icon="⌁" tone="cyan" /><Stat label="Movement intensity" value={reading ? `${reading.intensity}%` : '—'} detail={live ? 'Calculated from live input' : 'Waiting for live input'} icon="◒" tone="blue" /><Stat label="Active projects" value="04" detail="Virtual simulations" icon="◈" tone="purple" /><Stat label="Last sequence" value={reading ? `${reading.sequence}` : '—'} detail="Arduino packet counter" icon="◷" tone="orange" /></div>
  </>
}
function Stat({ label, value, detail, icon, tone }: { label: string; value: string; detail: string; icon: string; tone: string }) {
  return <div className="stat-card"><div className={`stat-icon ${tone}`}>{icon}</div><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></div>
}
function Lab({ navigate }: { navigate: (path: string) => void }) {
  return <><PageHeader eyebrow="PROJECT LAB / 02" title="Choose your simulation." description="Every module uses readings from the connected Arduino sensor." /><div className="project-grid">{projects.map((project, index) => <button className={`project-card ${project.tone}`} key={project.name} onClick={() => navigate(project.route)}><div className="project-art"><span className="project-number">0{index + 1}</span><div className={`art-shape shape-${index}`} /></div><div className="project-info"><div><span className="eyebrow">{project.name}</span><h3>{project.title}</h3></div><span className="card-arrow">↗</span><p>{project.description}</p><small><span className="dot" />{project.metric}</small></div></button>)}</div></>
}
function ProjectPage({ path, reading, arvrReadings, neutral, setNeutral, calibrated, setCalibrated, running, setRunning, alert }: { path: string; reading: SensorReading | null; arvrReadings: { left: SensorReading | null; right: SensorReading | null }; neutral?: NeutralReading; setNeutral: (neutral: NeutralReading) => void; calibrated: boolean; setCalibrated: (value: boolean) => void; running: boolean; setRunning: (running: boolean) => void; alert?: string }) {
  const config = useMemo(() => projects.find((project) => project.route === path) ?? projects[0], [path])
  const isArm = path === '/motion-sync'; const isCrash = path === '/crash-guard'; const isRobotCar = path === '/robo-drive'; const isGestureSpace = path === '/gesture-space'
  const armOrientation = reading?.displayOrientation ?? [0, 0, 0]
  const carDirection = reading ? directionFromTilt(reading.displayOrientation, reading.displayAccel, reading.hasOrientation || reading.simulated, reading.direction, neutral) : 'NONE'
  const motors = running ? motorCommandForDirection(carDirection) : stopMotors()
  return <><PageHeader eyebrow={`VIRTUAL PROJECT / ${config.name.toUpperCase()}`} title={config.title} description={config.description}><div className="control-row"><button className={`run-button ${running ? 'running' : ''}`} onClick={() => setRunning(!running)}><span />{running ? 'Running' : 'Stopped'}</button><button className="outline-button" onClick={() => { if (reading) setNeutral({ accel: reading.displayAccel, orientation: reading.displayOrientation }); setCalibrated(true) }}>{calibrated ? 'Calibrated ✓' : 'Calibrate neutral'}</button><button className="square-button" onClick={() => setCalibrated(false)}>↻</button></div></PageHeader>
    <div className="simulation-layout"><section className="simulation-stage">{isArm ? <HandModel orientation={armOrientation} gyro={reading?.displayGyro ?? [0, 0, 0]} live={Boolean(reading?.hasOrientation || reading?.simulated)} simulated={Boolean(reading?.simulated)} /> : isRobotCar ? <RobotCar direction={carDirection} motors={motors} running={running} live={Boolean(reading)} /> : isGestureSpace ? <DinoGame left={arvrReadings.left} right={arvrReadings.right} fallback={reading} live={Boolean(arvrReadings.left || arvrReadings.right || reading)} /> : <div className={`simulation-object ${config.tone}`}><div className="object-ring" /><div className="object-core">{isCrash ? '▰' : '✦'}</div><div className="object-label">{reading ? `${reading.deviceId} // ${moduleLabels[reading.module].toUpperCase()}` : `WAITING FOR ${moduleLabels[moduleForPath[path]].toUpperCase()}`}</div></div>}{reading?.direction && <div className="direction-readout">COMMAND <strong>{reading.direction}</strong></div>}{isRobotCar && <div className="direction-readout">TILT COMMAND <strong>{carDirection}</strong></div>}{isGestureSpace && <div className="direction-readout">DINO CONTROL <strong>{arvrReadings.left && arvrReadings.right ? '2-PORT LIVE' : arvrReadings.left || reading ? 'COM5 LIVE' : 'WAITING FOR SENSOR'}</strong></div>}{alert && <div className="alert-readout">⚠ {alert}</div>}        <div className="stage-toolbar"><span>{isGestureSpace ? '◉ JUMP ON ACCEL + JERK' : '◉ LIVE IMU ROTATION'}</span><span>MODULE {moduleLabels[moduleForPath[path]].toUpperCase()}</span><span>100%</span></div></section><aside className="telemetry-panel"><div className="panel-title">{isGestureSpace ? 'Dino telemetry' : 'Live telemetry'} <span className="source-label">{reading ? (reading.simulated ? 'SIMULATION' : moduleLabels[reading.module].toUpperCase()) : 'NO SIGNAL'}</span></div>{isGestureSpace ? <DinoTelemetry left={arvrReadings.left} right={arvrReadings.right} fallback={reading} /> : reading ? <><Telemetry label="Orientation" values={reading.displayOrientation} units="°" unavailable={!reading.hasOrientation && !reading.simulated} /><Telemetry label="Acceleration" values={reading.displayAccel} units="m/s²" /><Telemetry label="Gyroscope" values={reading.displayGyro} units="°/s" unavailable={!reading.hasGyro} /><Intensity value={reading.intensity} />{isRobotCar && <div className="robot-motor-diagnostics"><span>VIRTUAL MOTOR OUTPUT</span><strong>L {motors.left.direction} {motors.left.speed}</strong><strong>R {motors.right.direction} {motors.right.speed}</strong></div>}</> : <NoSignal />}</aside></div>
  </>
}

function directionFromTilt(orientation: [number, number, number], accel: [number, number, number], hasOrientation: boolean, reportedDirection?: HardwareEvent['direction'], neutral?: NeutralReading): 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'NONE' {
  if (reportedDirection && reportedDirection !== 'NONE') return reportedDirection
  const adjustedAccel: [number, number, number] = neutral ? [accel[0] - neutral.accel[0], accel[1] - neutral.accel[1], accel[2] - neutral.accel[2]] : accel
  const adjustedOrientation: [number, number, number] = neutral ? [orientation[0] - neutral.orientation[0], orientation[1] - neutral.orientation[1], orientation[2] - neutral.orientation[2]] : orientation
  if (hasOrientation && (Math.abs(adjustedOrientation[0]) >= 10 || Math.abs(adjustedOrientation[1]) >= 10)) {
    const [roll, pitch] = adjustedOrientation
    if (Math.abs(pitch) >= Math.abs(roll)) return pitch < 0 ? 'UP' : 'DOWN'
    return roll < 0 ? 'LEFT' : 'RIGHT'
  }
  const accelerationScale = Math.max(Math.abs(adjustedAccel[0]), Math.abs(adjustedAccel[1])) > 2 ? 9.80665 : 1
  const accelPitch = adjustedAccel[0] / accelerationScale
  const accelRoll = adjustedAccel[1] / accelerationScale
  if (Math.max(Math.abs(accelPitch), Math.abs(accelRoll)) >= 0.18) {
    if (Math.abs(accelPitch) >= Math.abs(accelRoll)) return accelPitch < 0 ? 'UP' : 'DOWN'
    return accelRoll < 0 ? 'LEFT' : 'RIGHT'
  }
  const [roll, pitch] = [accelRoll * 45, accelPitch * 45]
  if (Math.abs(pitch) >= Math.abs(roll) && Math.abs(pitch) >= 10) return pitch < 0 ? 'UP' : 'DOWN'
  if (Math.abs(roll) >= 10) return roll < 0 ? 'LEFT' : 'RIGHT'
  return 'NONE'
}

function motorCommandForDirection(direction: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'NONE'): { left: MotorState; right: MotorState } {
  if (direction === 'UP') return { left: { direction: 'FORWARD', speed: 220 }, right: { direction: 'FORWARD', speed: 220 } }
  if (direction === 'DOWN') return { left: { direction: 'BACKWARD', speed: 220 }, right: { direction: 'BACKWARD', speed: 220 } }
  if (direction === 'LEFT') return { left: { direction: 'FORWARD', speed: 90 }, right: { direction: 'FORWARD', speed: 220 } }
  if (direction === 'RIGHT') return { left: { direction: 'FORWARD', speed: 220 }, right: { direction: 'FORWARD', speed: 90 } }
  return stopMotors()
}

function stopMotors(): { left: MotorState; right: MotorState } {
  return { left: { direction: 'STOP', speed: 0 }, right: { direction: 'STOP', speed: 0 } }
}

function RobotCar({ direction, motors, running, live }: { direction: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'NONE'; motors: { left: MotorState; right: MotorState }; running: boolean; live: boolean }) {
  return <div className={`robot-car-scene direction-${direction.toLowerCase()} ${running ? 'car-running' : 'car-stopped'}`}>
    <div className="robot-car-status">{live ? `ROBOT CAR // ${running ? 'READY TO MOVE' : 'STOPPED'}` : 'ROBOT CAR // WAITING FOR MPU6050'}</div>
  <div className="robot-car-track"><div className="robot-car"><span className="car-cabin" /><span className="car-roof-rack" /><span className="car-wheel wheel-front" /><span className="car-wheel wheel-back" /><span className="car-light light-left" /><span className="car-light light-right" /><span className="car-bumper" /></div></div>
    <div className="robot-car-command">{direction === 'NONE' ? 'HOLD POSITION' : direction}</div>
    <div className="robot-car-controls"><span>← LEFT</span><span>↑ FORWARD</span><span>↓ BACKWARD</span><span>RIGHT →</span><span>L {motors.left.speed} · R {motors.right.speed}</span></div>
  </div>
}

function DinoGame({ left, right, fallback, live }: { left: SensorReading | null; right: SensorReading | null; fallback: SensorReading | null; live: boolean }) {
  const [jumping, setJumping] = useState(false)
  const [score, setScore] = useState(0)
  const lastJump = useRef(0)
  const jumpArmed = useRef(true)
  const jumpTimer = useRef<number | null>(null)
  const dinoRef = useRef<HTMLDivElement>(null)
  const obstacleRefs = useRef<Array<HTMLDivElement | null>>([])
  const readings = [left, right, fallback].filter((value): value is SensorReading => Boolean(value))
  const intensity = readings.length ? Math.max(...readings.map((value) => value.intensity)) : 0
  const jerk = readings.length ? Math.max(...readings.map((value) => value.jerk)) : 0
  const acceleration = readings.length ? Math.max(...readings.map((value) => {
    const scale = Math.max(...value.accel.map((axis) => Math.abs(axis))) <= 3 ? 9.80665 : 1
    return Math.sqrt(value.accel[0] ** 2 + value.accel[1] ** 2 + value.accel[2] ** 2) * scale
  })) : 0
  const latestSequence = readings.length ? Math.max(...readings.map((value) => value.sequence)) : 0
  useEffect(() => {
    if (acceleration < DINO_ACCELERATION_RESET || jerk < DINO_JERK_RESET) {
      jumpArmed.current = true
      return
    }
    if (acceleration < DINO_ACCELERATION_THRESHOLD || jerk < DINO_JERK_THRESHOLD || !jumpArmed.current || Date.now() - lastJump.current < 900) return
    jumpArmed.current = false
    lastJump.current = Date.now()
    setJumping(true)
    setScore((value) => value + 1)
    if (jumpTimer.current !== null) window.clearTimeout(jumpTimer.current)
    jumpTimer.current = window.setTimeout(() => {
      setJumping(false)
      jumpTimer.current = null
    }, 900)
  }, [acceleration, jerk, latestSequence])
  useEffect(() => () => {
    if (jumpTimer.current !== null) window.clearTimeout(jumpTimer.current)
  }, [])
  useEffect(() => {
    const timer = window.setInterval(() => {
      const dino = dinoRef.current?.getBoundingClientRect()
      if (!dino) return
      const hit = obstacleRefs.current.some((obstacle) => {
        const box = obstacle?.getBoundingClientRect()
        return Boolean(box && dino.left < box.right && dino.right > box.left && dino.top < box.bottom && dino.bottom > box.top)
      })
      if (hit) setScore(0)
    }, 50)
    return () => window.clearInterval(timer)
  }, [])
  return <div className="dino-scene">
    <div className="dino-status">{live ? 'DINO RUN // LIVE ACCELERATION' : 'DINO RUN // WAITING FOR SENSOR'}</div>
    <div className="dino-hud"><span>SCORE {score.toString().padStart(3, '0')}</span><span>INTENSITY {intensity}%</span><span>ACCEL {acceleration.toFixed(1)} m/s²</span><span>JERK {jerk.toFixed(1)} m/s³</span></div>
    <div className="dino-sky"><span className="dino-cloud cloud-one" /><span className="dino-cloud cloud-two" /></div>
    <div className="dino-track"><div ref={dinoRef} className={`dino-character ${jumping ? 'jumping' : ''}`}>🦖</div><div ref={(element) => { obstacleRefs.current[0] = element }} className="dino-cactus cactus-one">▥</div><div ref={(element) => { obstacleRefs.current[1] = element }} className="dino-cactus cactus-two">▥</div></div>
    <div className="dino-readout">{jumping ? 'JUMP!' : acceleration >= DINO_ACCELERATION_THRESHOLD && jerk >= DINO_JERK_THRESHOLD ? 'READY' : 'ACCEL > 15 + JERK > 200'}</div>
  </div>
}

function DinoTelemetry({ left, right, fallback }: { left: SensorReading | null; right: SensorReading | null; fallback: SensorReading | null }) {
  const readings = [left, right, fallback].filter((value): value is SensorReading => Boolean(value))
  const intensity = readings.length ? Math.max(...readings.map((value) => value.intensity)) : 0
  const acceleration = readings.length ? Math.max(...readings.map((value) => {
    const scale = Math.max(...value.accel.map((axis) => Math.abs(axis))) <= 3 ? 9.80665 : 1
    return Math.sqrt(value.accel[0] ** 2 + value.accel[1] ** 2 + value.accel[2] ** 2) * scale
  })) : 0
  const jerk = readings.length ? Math.max(...readings.map((value) => value.jerk)) : 0
  return <div className="dino-telemetry"><div><span>Movement intensity</span><strong>{intensity}%</strong></div><div><span>Acceleration trigger</span><strong>{acceleration.toFixed(1)} / {DINO_ACCELERATION_THRESHOLD} m/s²</strong></div><div><span>Jerk trigger</span><strong>{jerk.toFixed(1)} / {DINO_JERK_THRESHOLD} m/s³</strong></div><div className="meter"><i style={{ width: `${Math.min(100, acceleration / DINO_ACCELERATION_THRESHOLD * 100)}%` }} /></div><p>Jumping requires acceleration above 15 m/s² and jerk above 200 m/s³. A box collision resets the score.</p></div>
}

function zAxisOffset(z: number): number {
  const zInG = Math.abs(z) > 3 ? z / 9.80665 : z
  const deadZone = 0.1
  const offset = Math.abs(zInG - 1) <= deadZone ? 0 : zInG - 1
  return Math.max(-1.5, Math.min(1.5, offset))
}

function smoothSimulationZ(previous: number | undefined, current: number, response: number): number {
  if (previous === undefined) return current
  return previous + (current - previous) * response
}

function simulatedOrientation(z: number, module: ExhibitionModule): [number, number, number] {
  const offset = zAxisOffset(z)
  const gain = module === 'robot_car' ? 18 : 26
  return [
    offset * gain,
    offset * gain * 1.9,
    0,
  ]
}

function simulatedAcceleration(z: number, module: ExhibitionModule): [number, number, number] {
  const offset = zAxisOffset(z)
  const zAcceleration = Math.abs(z) > 3 ? z : z * 9.80665
  const gain = module === 'robot_car' ? 2.4 : 3.2
  return [
    offset * gain,
    offset * -gain * 0.68,
    zAcceleration,
  ]
}

function simulatedGyro(z: number, module: ExhibitionModule): [number, number, number] {
  const offset = zAxisOffset(z)
  const gain = module === 'robot_car' ? 4 : 6
  return [
    offset * gain,
    offset * gain * 0.66,
    offset * gain * 0.33,
  ]
}

function HandModel({ orientation, gyro, live, simulated }: { orientation: [number, number, number]; gyro: [number, number, number]; live: boolean; simulated: boolean }) {
  const [roll, pitch, yaw] = orientation
  const [gyroX, gyroY, gyroZ] = gyro
  const rotation = {
    x: Math.max(-65, Math.min(65, pitch + gyroY * 0.12)),
    y: Math.max(-65, Math.min(65, yaw + gyroZ * 0.12)),
    z: Math.max(-65, Math.min(65, roll + gyroX * 0.12)),
  }
  return <div className="hand-scene">
    <div className="hand-status">{simulated ? 'HAND // SIMULATED FROM LIVE Z ACCELERATION' : live ? 'HAND // FOLLOWING LIVE ORIENTATION' : 'HAND // WAITING FOR MPU6050 ORIENTATION'}</div>
    <div className="hand-model" style={{ transform: `rotateY(${rotation.y}deg) rotateX(${rotation.x}deg) rotateZ(${rotation.z}deg)` }}>
      <div className="hand-palm" />
      <div className="hand-thumb" />
      <div className="hand-finger hand-index" />
      <div className="hand-finger hand-middle" />
      <div className="hand-finger hand-ring" />
      <div className="hand-finger hand-pinky" />
    </div>
    <div className="hand-axis-labels"><span>R {roll.toFixed(1)}°</span><span>P {pitch.toFixed(1)}°</span><span>Y {yaw.toFixed(1)}°</span><span>GX {gyroX.toFixed(1)}</span><span>GY {gyroY.toFixed(1)}</span><span>GZ {gyroZ.toFixed(1)}</span></div>
  </div>
}
function NoSignal() { return <div className="disclosure">No Arduino data received. Connect the board and select its serial port in System. MotionSync simulation starts only from a live hardware packet missing orientation.</div> }
function Intensity({ value }: { value: number }) { return <div className="intensity"><div><span>Movement intensity</span><strong>{value}%</strong></div><div className="meter"><i style={{ width: `${value}%` }} /></div></div> }
function Telemetry({ label, values, units, unavailable = false }: { label: string; values: [number, number, number]; units: string; unavailable?: boolean }) {
  return <div className="telemetry-row"><span>{label}</span><div>{values.map((value, index) => <strong className={unavailable ? 'unavailable-value' : ''} key={index}><i>{['X', 'Y', 'Z'][index]}</i>{unavailable ? '—' : value.toFixed(2)}<small>{unavailable ? '' : units}</small></strong>)}</div></div>
}
function Analytics({ reading, history }: { reading: SensorReading | null; history: number[] }) {
  return <><PageHeader eyebrow="MOTION ANALYTICS / 05" title="Read the movement." description="A clear view of live Arduino telemetry and derived metrics." /><div className="analytics-grid"><section className="chart-card"><div className="card-heading"><div><span className="eyebrow">MOVEMENT INTENSITY</span><h2>Live signal</h2></div><span className="source-label">{reading ? 'HARDWARE' : 'NO SIGNAL'}</span></div>{history.length ? <><div className="chart"><div className="chart-y"><span>100</span><span>50</span><span>0</span></div><div className="bars">{history.map((height, index) => <i key={index} style={{ height: `${height}%` }} />)}</div></div><div className="chart-foot"><span>− 15 readings</span><span>Now</span></div></> : <NoSignal />}</section><section className="chart-card"><div className="card-heading"><div><span className="eyebrow">CURRENT READING</span><h2>Sensor channels</h2></div></div>{reading ? <>  <Telemetry label="Acceleration" values={reading.accel} units="m/s²" /><Telemetry label="Gyroscope" values={reading.gyro} units="°/s" /><Telemetry label="Orientation" values={reading.orientation} units="°" /></> : <NoSignal />}</section></div><div className="analytics-bottom"><Stat label="Device" value={reading?.deviceId ?? '—'} detail="Arduino identifier" icon="⌁" tone="cyan" /><Stat label="Sequence" value={reading ? `${reading.sequence}` : '—'} detail="Validated packet" icon="◷" tone="blue" /><Stat label="Data source" value={reading ? 'Hardware' : '—'} detail="No generated values" icon="◇" tone="orange" /></div></>
}
function System({ status, statusMessage }: { status: HardwareStatus; statusMessage: string }) {
  const [ports, setPorts] = useState<SerialPortInfo[]>([])
  const [selectedPath, setSelectedPath] = useState('COM5')
  const [selectedModule, setSelectedModule] = useState<ExhibitionModule>('accident_alert')
  const [protocol, setProtocol] = useState<SerialProtocol>('auto')
  const [error, setError] = useState('')
  const loadPorts = async () => {
    try {
      const response = await fetch(`${bridgeUrl}/ports`)
      if (!response.ok) throw new Error('Bridge did not return serial ports')
      const available = await response.json() as SerialPortInfo[]
      setPorts(available)
      setSelectedPath(available.find((port) => port.path === 'COM5')?.path ?? available[0]?.path ?? '')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to list serial ports')
    }
  }
  useEffect(() => { void loadPorts() }, [])
  const connect = async () => {
    setError('')
    try {
      const response = await fetch(`${bridgeUrl}/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: selectedPath, baudRate: 115200, module: selectedModule, protocol }) })
      if (!response.ok) { const result = await response.json() as { error?: string }; throw new Error(result.error ?? 'Unable to connect') }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to connect')
    }
  }
  return <><PageHeader eyebrow="SYSTEM / 06" title="Hardware connection." description="Select the Arduino serial port, exhibition module and protocol. The browser only displays validated hardware readings." /><div className="system-grid"><section className="settings-card"><div className="card-heading"><div><span className="eyebrow">DEVICE REGISTRY</span><h2>Arduino serial bridge</h2></div><button className="outline-button small" onClick={loadPorts}>Scan ports</button></div><div className="device-row"><div className="device-icon">⌁</div><div><strong>{status === 'connected' ? 'Motion Sensor 01' : 'No connected board'}</strong><span>{status === 'connected' ? statusMessage : 'MPU6050 · USB Serial'}</span></div><span className={`device-state ${status !== 'connected' ? 'offline-text' : ''}`}><span className="dot" /> {status === 'connected' ? 'Live data' : 'Disconnected'}</span></div><div className="connect-controls"><select value={selectedPath} onChange={(event) => setSelectedPath(event.target.value)}><option value="">Select a serial port</option>{ports.map((port) => <option value={port.path} key={port.path}>{port.path}{port.manufacturer ? ` · ${port.manufacturer}` : ''}</option>)}</select><select value={selectedModule} onChange={(event) => setSelectedModule(event.target.value as ExhibitionModule)}>{Object.entries(moduleLabels).filter(([value]) => value !== 'analytics').map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select><select value={protocol} onChange={(event) => setProtocol(event.target.value as SerialProtocol)}><option value="auto">Auto detect</option><option value="angles_csv">roll,pitch,yaw CSV</option><option value="direction_text">UP/DOWN/LEFT/RIGHT/NONE</option><option value="accident_text">Accel / accident text</option><option value="json">JSON envelope</option></select><button className="primary-button" disabled={!selectedPath} onClick={connect}>Connect board</button></div>{error && <div className="error-note">{error}</div>}</section><section className="settings-card environment-card"><span className="eyebrow">JUMPDINO CONTROL</span><h2>Acceleration + jerk</h2><p>JumpDino uses COM5 only. A jump requires acceleration above 15 m/s² and jerk above 200 m/s³.</p><div className="warning-note">ⓘ Select JumpDino, choose COM5, close its Serial Monitor, and connect the board. Box collisions reset the score.</div></section></div></>
}

export default App
