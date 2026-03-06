import express from 'express'
import cors from 'cors'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fundsRouter } from './routes/funds.js'
import { computeRouter } from './routes/compute.js'
import { exportRouter } from './routes/export.js'
import { platformsRouter } from './routes/platforms.js'
import { importRouter } from './routes/import.js'
import { backupRouter } from './routes/backup.js'
import { testDataRouter } from './routes/test-data.js'
import { errorHandler } from './middleware/error-handler.js'
import { initWebSocket } from './services/websocket.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const app: ReturnType<typeof express> = express()
const server = createServer(app)
const PORT = process.env['PORT'] ?? 5551

const allowedOriginsEnv = process.env['ALLOWED_ORIGINS']
const allowedOrigins =
  allowedOriginsEnv !== undefined
    ? allowedOriginsEnv
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0)
    : ['http://localhost:5550', 'http://localhost:5551']

app.use(cors({
  origin: allowedOrigins.length > 0 ? allowedOrigins : ['http://localhost:5550', 'http://localhost:5551']
}))
app.use(express.json({ limit: '50mb' }))

// API routes - simplified model
app.use('/api/v1/funds', fundsRouter)
app.use('/api/v1/compute', computeRouter)
app.use('/api/v1/export', exportRouter)
app.use('/api/v1/platforms', platformsRouter)
app.use('/api/v1/import', importRouter)
app.use('/api/v1/backup', backupRouter)
app.use('/api/v1/test-data', testDataRouter)

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Version endpoint
app.get('/api/version', async (_req, res) => {
  const pkgPath = join(__dirname, '..', '..', '..', 'package.json')
  const pkgContent = await readFile(pkgPath, 'utf-8')
  const pkg = JSON.parse(pkgContent) as { version: string; name: string }
  res.json({ version: pkg.version, name: pkg.name })
})

// Error handling
app.use(errorHandler)

// Production: serve built web UI
if (process.env['NODE_ENV'] === 'production') {
  const webDist = join(__dirname, '..', '..', 'web', 'dist')
  app.use(express.static(webDist))
  app.get('{*path}', (_req, res) => {
    res.sendFile(join(webDist, 'index.html'))
  })
}

// Initialize WebSocket server
initWebSocket(server)

server.listen(PORT, () => {
  console.log(`EscapeMint API running on http://localhost:${String(PORT)}`)
  console.log(`WebSocket available at ws://localhost:${String(PORT)}/ws`)
})

export { app, server }
