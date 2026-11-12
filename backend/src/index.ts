import cors from 'cors'
import express from 'express'
import { createServer } from 'node:http'
import { SerialPort } from 'serialport'
import { ReadlineParser } from '@serialport/parser-readline'
import { Server } from 'socket.io'
import { z } from 'zod'

const port = Number(process.env.PORT ?? 8787)
const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, { cors: { origin: process.env.FRONTEND_ORIGIN ?? true } })
const sensorEvent = z.object({
  deviceId: z.string().min(1),
  module: z.enum(['accident_alert', 'robot_arm', 'robot_car', 'gesture_world', 'analytics']).optional(),
  type: z.literal('sensor:update'),
  sequence: z.number().int().nonnegative(),
  timestamp: z.number(),
  source: z.literal('hardware'),
  accel: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  gyro: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  orientation: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
  direction: z.enum(['UP', 'DOWN', 'LEFT', 'RIGHT', 'NONE']).optional(),
  alert: z.string().optional(),
})
const moduleSchema = z.enum(['accident_alert', 'robot_arm', 'robot_car', 'gesture_world', 'analytics'])
const connectSchema = z.object({
  path: z.string().min(1),
  baudRate: z.number().int().positive().default(115200),
  module: moduleSchema.default('robot_arm'),
  protocol: z.enum(['auto', 'json', 'angles_csv', 'labeled_csv', 'direction_text', 'accident_text']).default('auto'),
})
const arvrConnectSchema = z.object({
  leftPath: z.string().min(1),
  rightPath: z.string().min(1),
  baudRate: z.number().int().positive().default(115200),
  protocol: z.enum(['auto', 'json', 'angles_csv', 'labeled_csv', 'direction_text', 'accident_text']).default('auto'),
}).refine(({ leftPath, rightPath }) => leftPath !== rightPath, { message: 'AR/VR requires two different serial ports.' })
type ArvrSide = 'left' | 'right'

app.use(cors())
app.get('/health', (_request, response) => response.json({ ok: true, source: 'hardware-bridge' }))
app.get('/ports', async (_request, response) => response.json((await SerialPort.list()).map(({ path, manufacturer, serialNumber }) => ({ path, manufacturer, serialNumber }))))

let activePort: SerialPort | undefined
const arvrPorts: Partial<Record<ArvrSide, SerialPort>> = {}
let activeModule: z.infer<typeof moduleSchema> = 'robot_arm'
let activeProtocol: 'auto' | 'json' | 'angles_csv' | 'labeled_csv' | 'direction_text' | 'accident_text' = 'auto'
const closePort = (serialPort: SerialPort | undefined) => serialPort?.isOpen
  ? new Promise<void>((resolve, reject) => serialPort.close((error) => error ? reject(error) : resolve()))
  : Promise.resolve()
const closeAllPorts = async () => {
  await closePort(activePort)
  await Promise.all([closePort(arvrPorts.left), closePort(arvrPorts.right)])
  activePort = undefined
  delete arvrPorts.left
  delete arvrPorts.right
}
const openSerialPort = (path: string, baudRate: number) => new Promise<SerialPort>((resolve, reject) => {
  const serialPort = new SerialPort({ path, baudRate, autoOpen: false })
  serialPort.open((error) => error ? reject(error) : resolve(serialPort))
})
const parseArvrLine = (line: string, protocol: z.infer<typeof connectSchema.shape.protocol>) => {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const json = JSON.parse(trimmed) as { type?: string; status?: string }
    if (json.type === 'hardware:status') return null
    return sensorEvent.parse(json)
  } catch (error) {
    if (protocol === 'json') throw error
  }
  const flatMotion = trimmed.match(/^R:\s*(-?\d+(?:\.\d+)?)\s*,P:\s*(-?\d+(?:\.\d+)?)\s*,Y:\s*(-?\d+(?:\.\d+)?)\s*,GX:\s*(-?\d+(?:\.\d+)?)\s*,GY:\s*(-?\d+(?:\.\d+)?)\s*,GZ:\s*(-?\d+(?:\.\d+)?)$/i)
  if (flatMotion && (protocol === 'auto' || protocol === 'angles_csv')) {
    return {
      deviceId: 'motion-01', type: 'sensor:update' as const, sequence: Date.now(), timestamp: Date.now(), source: 'hardware' as const,
      accel: { x: 0, y: 0, z: 0 },
      gyro: { x: Number(flatMotion[4]), y: Number(flatMotion[5]), z: Number(flatMotion[6]) },
      orientation: { x: Number(flatMotion[1]), y: Number(flatMotion[2]), z: Number(flatMotion[3]) },
    }
  }
  const values = trimmed.split(',').map(Number)
  if ((protocol === 'auto' || protocol === 'angles_csv') && values.length === 3 && values.every((value) => Number.isFinite(value))) {
    return {
      deviceId: 'motion-01', type: 'sensor:update' as const, sequence: Date.now(), timestamp: Date.now(), source: 'hardware' as const,
      accel: { x: 0, y: 0, z: 0 }, gyro: { x: 0, y: 0, z: 0 },
      orientation: { x: values[0], y: values[1], z: values[2] },
    }
  }
  const direction = trimmed.toUpperCase()
  if ((protocol === 'auto' || protocol === 'direction_text') && ['UP', 'DOWN', 'LEFT', 'RIGHT', 'NONE'].includes(direction)) {
    return {
      deviceId: 'motion-01', type: 'sensor:update' as const, sequence: Date.now(), timestamp: Date.now(), source: 'hardware' as const,
      accel: { x: 0, y: 0, z: 0 }, gyro: { x: 0, y: 0, z: 0 },
      direction: direction as 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'NONE',
    }
  }
  const accelMatch = trimmed.match(/^Accel:\s*(-?\d+(?:\.\d+)?)\s*G?$/i)
  if ((protocol === 'auto' || protocol === 'accident_text') && accelMatch) {
    return {
      deviceId: 'motion-01', type: 'sensor:update' as const, sequence: Date.now(), timestamp: Date.now(), source: 'hardware' as const,
      accel: { x: 0, y: 0, z: Number(accelMatch[1]) }, gyro: { x: 0, y: 0, z: 0 },
    }
  }
  throw new Error('Expected JSON sensor data or roll,pitch,yaw CSV values')
}

app.post('/connect-arvr', express.json(), async (request, response) => {
  const requested = arvrConnectSchema.safeParse(request.body)
  if (!requested.success) return response.status(400).json({ error: requested.error.issues[0]?.message ?? 'Two valid serial paths are required.' })
  try {
    await closeAllPorts()
    for (const [side, path] of [['left', requested.data.leftPath], ['right', requested.data.rightPath]] as const) {
      let serialPort: SerialPort
      try {
        serialPort = await openSerialPort(path, requested.data.baudRate)
      } catch (error) {
        throw new Error(`${side.toUpperCase()} port ${path} could not be opened: ${error instanceof Error ? error.message : 'serial open failed'}`)
      }
      arvrPorts[side] = serialPort
      const parser = serialPort.pipe(new ReadlineParser({ delimiter: '\n' }))
      parser.on('data', (line: string) => {
        try {
          const event = parseArvrLine(line, requested.data.protocol)
          if (event) io.emit('sensor:update', { ...event, module: 'gesture_world', side })
        } catch (error) {
          io.emit('hardware:status', { status: 'invalid-data', side, message: `${error instanceof Error ? error.message : 'Invalid AR/VR serial message'}` })
        }
      })
      serialPort.on('close', () => io.emit('hardware:disconnect', { source: 'hardware', side }))
      serialPort.on('error', (error) => io.emit('hardware:status', { status: 'error', side, message: error.message }))
      io.emit('hardware:connect', { path, source: 'hardware', side })
    }
    return response.status(201).json({ connected: true, leftPath: requested.data.leftPath, rightPath: requested.data.rightPath })
  } catch (error) {
    await closeAllPorts()
    return response.status(500).json({ error: error instanceof Error ? error.message : 'Unable to connect both AR/VR serial ports.' })
  }
})

app.post('/connect', express.json(), async (request, response) => {
  const requestedPath = connectSchema.safeParse(request.body)
  if (!requestedPath.success) return response.status(400).json({ error: 'A valid serial path and baud rate are required.' })
  activeModule = requestedPath.data.module
  activeProtocol = requestedPath.data.protocol
  await closeAllPorts()
  activePort = new SerialPort({ path: requestedPath.data.path, baudRate: requestedPath.data.baudRate })
  const parser = activePort.pipe(new ReadlineParser({ delimiter: '\n' }))
  parser.on('data', (line: string) => {
    try {
      const event = parseSerialLine(line)
      if (event) io.emit('sensor:update', event)
    } catch (error) {
      const sample = line.trim().slice(0, 120)
      io.emit('hardware:status', { status: 'invalid-data', message: `${error instanceof Error ? error.message : 'Invalid serial message'} Received: ${sample}` })
    }
  })

  function parseSerialLine(line: string) {
    const trimmed = line.trim()
    if (!trimmed) return null
    const selectedProtocol = activeProtocol
    try {
      const json = JSON.parse(trimmed) as { type?: string; status?: string }
      if (json.type === 'hardware:status') {
        io.emit('hardware:status', { status: json.status ?? 'ready', source: 'hardware' })
        return null
      }
      const parsed = sensorEvent.parse(json)
      return { ...parsed, module: activeModule }
    } catch (error) {
      if (activeProtocol === 'json') throw error
    }
    if (activeProtocol === 'direction_text' || activeProtocol === 'auto') {
      const direction = trimmed.toUpperCase()
      if (['UP', 'DOWN', 'LEFT', 'RIGHT', 'NONE'].includes(direction)) {
        return {
          deviceId: 'motion-01', module: activeModule, type: 'sensor:update' as const,
          sequence: Date.now(), timestamp: Date.now(), source: 'hardware' as const,
          accel: { x: 0, y: 0, z: 0 }, gyro: { x: 0, y: 0, z: 0 },
          direction: direction as 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'NONE',
        }
      }
      const readLabeled = (name: string) => {
        const match = trimmed.match(new RegExp(`${name}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, 'i'))
        return match ? Number(match[1]) : undefined
      }
      const flatMotion = trimmed.match(/^R:\s*(-?\d+(?:\.\d+)?)\s*,P:\s*(-?\d+(?:\.\d+)?)\s*,Y:\s*(-?\d+(?:\.\d+)?)\s*,GX:\s*(-?\d+(?:\.\d+)?)\s*,GY:\s*(-?\d+(?:\.\d+)?)\s*,GZ:\s*(-?\d+(?:\.\d+)?)$/i)
      if (flatMotion && (selectedProtocol === 'auto' || selectedProtocol === 'angles_csv')) {
        return {
          deviceId: 'motion-01', module: activeModule, type: 'sensor:update' as const,
          sequence: Date.now(), timestamp: Date.now(), source: 'hardware' as const,
          accel: { x: 0, y: 0, z: 0 },
          gyro: { x: Number(flatMotion[4]), y: Number(flatMotion[5]), z: Number(flatMotion[6]) },
          orientation: { x: Number(flatMotion[1]), y: Number(flatMotion[2]), z: Number(flatMotion[3]) },
        }
      }
      const labeledNames = ['ACC_X', 'ACC_Y', 'ACC_Z', 'GYRO_X', 'GYRO_Y', 'GYRO_Z', 'ROLL', 'PITCH', 'YAW']
      if (labeledNames.every((name) => readLabeled(name) !== undefined) && selectedProtocol !== 'json' && selectedProtocol !== 'angles_csv') {
        return {
          deviceId: 'motion-01', module: activeModule, type: 'sensor:update' as const,
          sequence: Date.now(), timestamp: Date.now(), source: 'hardware' as const,
          accel: { x: readLabeled('ACC_X')!, y: readLabeled('ACC_Y')!, z: readLabeled('ACC_Z')! },
          gyro: { x: readLabeled('GYRO_X')!, y: readLabeled('GYRO_Y')!, z: readLabeled('GYRO_Z')! },
          orientation: { x: readLabeled('ROLL')!, y: readLabeled('PITCH')!, z: readLabeled('YAW')! },
        }
      }
    }
    const accelMatch = trimmed.match(/^Accel:\s*(-?\d+(?:\.\d+)?)\s*G?$/i)
    if (accelMatch && (activeProtocol === 'accident_text' || activeProtocol === 'auto')) {
      const acceleration = Number(accelMatch[1])
      return {
        deviceId: 'motion-01', module: activeModule, type: 'sensor:update' as const,
        sequence: Date.now(), timestamp: Date.now(), source: 'hardware' as const,
        accel: { x: 0, y: 0, z: acceleration }, gyro: { x: 0, y: 0, z: 0 },
      }
    }
    if ((activeProtocol === 'accident_text' || activeProtocol === 'auto') && /ACCIDENT DETECTED|ALERT/i.test(trimmed)) {
      return {
        deviceId: 'motion-01', module: activeModule, type: 'sensor:update' as const,
        sequence: Date.now(), timestamp: Date.now(), source: 'hardware' as const,
        accel: { x: 0, y: 0, z: 0 }, gyro: { x: 0, y: 0, z: 0 }, alert: trimmed,
      }
    }
    if (/^(Calibrating|Calibration done|=+|Peak Acceleration:|ACCEL:)/i.test(trimmed)) return null
    const values = trimmed.split(',').map(Number)
    if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) {
      throw new Error('Expected JSON sensor data or roll,pitch,yaw CSV values')
    }
    return {
      deviceId: 'motion-01',
      module: activeModule,
      type: 'sensor:update' as const,
      sequence: Date.now(),
      timestamp: Date.now(),
      source: 'hardware' as const,
      accel: { x: 0, y: 0, z: 0 },
      gyro: { x: 0, y: 0, z: 0 },
      orientation: { x: values[0], y: values[1], z: values[2] },
    }
  }
  activePort.on('close', () => io.emit('hardware:disconnect', { source: 'hardware' }))
  activePort.on('error', (error) => io.emit('hardware:status', { status: 'error', message: error.message }))
  io.emit('hardware:connect', { path: requestedPath.data.path, source: 'hardware' })
  return response.status(201).json({ connected: true, path: requestedPath.data.path })
})

io.on('connection', (socket) => socket.emit('hardware:status', { status: activePort?.isOpen || arvrPorts.left?.isOpen || arvrPorts.right?.isOpen ? 'connected' : 'disconnected', source: 'hardware' }))
httpServer.listen(port, '0.0.0.0', () => console.log(`Gesture Tech Lab bridge listening on 0.0.0.0:${port}`))
