/**
 * WebSocket Service
 *
 * Provides real-time updates to dashboard clients.
 * Sends cached data immediately, then streams updates as they compute.
 */

import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'http'
import {
  getFundSummaries,
  getAggregateMetrics,
  getHistory,
  addCacheListener,
  invalidateCache,
  type DashboardFundSummary,
  type DashboardMetrics,
  type DashboardHistory
} from './dashboard-cache.js'

interface WSClient {
  ws: WebSocket
  subscriptions: Set<string>
  includeTest: boolean
}

// Active WebSocket connections
const clients = new Map<WebSocket, WSClient>()

// Message types
type ClientMessage =
  | { type: 'subscribe'; channel: 'dashboard'; includeTest?: boolean }
  | { type: 'unsubscribe'; channel: 'dashboard' }
  | { type: 'refresh' }

type ServerMessage =
  | { type: 'dashboard:funds'; data: DashboardFundSummary[] }
  | { type: 'dashboard:metrics'; data: DashboardMetrics }
  | { type: 'dashboard:history'; data: DashboardHistory }
  | { type: 'dashboard:history:computing'; data: { status: string } }
  | { type: 'error'; message: string }
  | { type: 'subscribed'; channel: string }

let wss: WebSocketServer | null = null

export function initWebSocket(server: Server): WebSocketServer {
  wss = new WebSocketServer({ server, path: '/ws' })

  wss.on('connection', (ws: WebSocket) => {
    const client: WSClient = {
      ws,
      subscriptions: new Set(),
      includeTest: false
    }
    clients.set(ws, client)

    ws.on('message', async (data: Buffer) => {
      const message = parseMessage(data)
      if (!message) return

      await handleMessage(client, message)
    })

    ws.on('close', () => {
      clients.delete(ws)
    })

    ws.on('error', () => {
      clients.delete(ws)
    })
  })

  // Listen for cache updates and broadcast
  addCacheListener((event, data) => {
    broadcast(event, data)
  })

  console.log('WebSocket server initialized on /ws')
  return wss
}

function parseMessage(data: Buffer): ClientMessage | null {
  try {
    const str = data.toString()
    return JSON.parse(str) as ClientMessage
  } catch {
    return null
  }
}

function send(ws: WebSocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message))
  }
}

function broadcast(event: string, data: unknown): void {
  const message = { type: event, data } as ServerMessage
  for (const [ws, client] of clients) {
    if (client.subscriptions.has('dashboard')) {
      send(ws, message)
    }
  }
}

async function handleMessage(client: WSClient, message: ClientMessage): Promise<void> {
  switch (message.type) {
    case 'subscribe':
      if (message.channel === 'dashboard') {
        client.subscriptions.add('dashboard')
        client.includeTest = message.includeTest ?? false

        send(client.ws, { type: 'subscribed', channel: 'dashboard' })

        // Send data progressively
        await sendDashboardData(client)
      }
      break

    case 'unsubscribe':
      client.subscriptions.delete(message.channel)
      break

    case 'refresh':
      // Invalidate cache and resend
      invalidateCache()
      if (client.subscriptions.has('dashboard')) {
        await sendDashboardData(client)
      }
      break
  }
}

async function sendDashboardData(client: WSClient): Promise<void> {
  // Send funds first (fastest)
  const funds = await getFundSummaries(client.includeTest)
  send(client.ws, { type: 'dashboard:funds', data: funds })

  // Then metrics
  const metrics = await getAggregateMetrics(client.includeTest)
  send(client.ws, { type: 'dashboard:metrics', data: metrics })

  // Finally history (slowest)
  send(client.ws, { type: 'dashboard:history:computing', data: { status: 'started' } })
  const history = await getHistory(client.includeTest)
  send(client.ws, { type: 'dashboard:history', data: history })
}

// Notify all clients when fund data changes
export async function notifyFundsChanged(): Promise<void> {
  invalidateCache()

  // Re-send data to all subscribed clients
  for (const [, client] of clients) {
    if (client.subscriptions.has('dashboard')) {
      await sendDashboardData(client)
    }
  }
}

export function getWebSocketServer(): WebSocketServer | null {
  return wss
}
