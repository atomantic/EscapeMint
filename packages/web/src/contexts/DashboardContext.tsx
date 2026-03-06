/**
 * Dashboard Context
 *
 * Provides shared WebSocket data to all dashboard components.
 * Single WebSocket connection shared across the entire dashboard.
 */

import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react'
import type { FundSummary, AggregateMetrics, HistoryResponse } from '../api/funds'
import { useSettings } from './SettingsContext'

// WebSocket URL - same host as API, /ws path
const WS_URL = `ws://${window.location.hostname}:5551/ws`

interface DashboardState {
  funds: FundSummary[] | null
  metrics: AggregateMetrics | null
  history: HistoryResponse | null
  fundsLoading: boolean
  metricsLoading: boolean
  historyLoading: boolean
  connected: boolean
  error: string | null
}

interface DashboardContextValue extends DashboardState {
  refresh: () => void
}

const DashboardContext = createContext<DashboardContextValue | null>(null)

type ServerMessage =
  | { type: 'dashboard:funds'; data: FundSummary[] }
  | { type: 'dashboard:metrics'; data: AggregateMetrics }
  | { type: 'dashboard:history'; data: HistoryResponse }
  | { type: 'dashboard:history:computing'; data: { status: string } }
  | { type: 'subscribed'; channel: string }
  | { type: 'error'; message: string }

interface DashboardProviderProps {
  children: ReactNode
}

export function DashboardProvider({ children }: DashboardProviderProps) {
  const { settings } = useSettings()
  const [state, setState] = useState<DashboardState>({
    funds: null,
    metrics: null,
    history: null,
    fundsLoading: true,
    metricsLoading: true,
    historyLoading: true,
    connected: false,
    error: null
  })

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<number | null>(null)
  const isUnmountingRef = useRef(false)
  const connectRef = useRef<(() => void) | null>(null)

  const connect = useCallback(() => {
    // Don't connect if unmounting
    if (isUnmountingRef.current) return

    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current)
      reconnectTimeoutRef.current = null
    }

    // Close existing connection
    if (wsRef.current) {
      wsRef.current.onclose = null // Prevent reconnect trigger
      wsRef.current.close()
    }

    const ws = new WebSocket(WS_URL)
    wsRef.current = ws

    ws.onopen = () => {
      if (isUnmountingRef.current) {
        ws.close()
        return
      }
      setState(prev => ({ ...prev, connected: true, error: null }))

      // Subscribe to dashboard channel with current test mode setting
      ws.send(JSON.stringify({
        type: 'subscribe',
        channel: 'dashboard',
        includeTest: settings.testFundsMode
      }))
    }

    ws.onmessage = (event) => {
      if (isUnmountingRef.current) return
      const message = JSON.parse(event.data as string) as ServerMessage

      switch (message.type) {
        case 'dashboard:funds':
          setState(prev => ({
            ...prev,
            funds: message.data,
            fundsLoading: false
          }))
          break

        case 'dashboard:metrics':
          setState(prev => ({
            ...prev,
            metrics: message.data,
            metricsLoading: false
          }))
          break

        case 'dashboard:history:computing':
          setState(prev => ({
            ...prev,
            historyLoading: true
          }))
          break

        case 'dashboard:history':
          setState(prev => ({
            ...prev,
            history: message.data,
            historyLoading: false
          }))
          break

        case 'error':
          setState(prev => ({
            ...prev,
            error: message.message
          }))
          break
      }
    }

    ws.onerror = () => {
      if (isUnmountingRef.current) return
      setState(prev => ({
        ...prev,
        connected: false,
        error: 'WebSocket connection error'
      }))
    }

    ws.onclose = () => {
      if (isUnmountingRef.current) return
      setState(prev => ({ ...prev, connected: false }))

      // Attempt reconnect after 3 seconds using ref to avoid stale closure
      reconnectTimeoutRef.current = window.setTimeout(() => {
        connectRef.current?.()
      }, 3000)
    }
  }, [settings.testFundsMode])

  // Keep ref in sync so reconnect always uses latest connect, after commit
  useEffect(() => {
    connectRef.current = connect
  }, [connect])

  // Refresh data
  const refresh = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      setState(prev => ({
        ...prev,
        fundsLoading: true,
        metricsLoading: true,
        historyLoading: true
      }))
      wsRef.current.send(JSON.stringify({ type: 'refresh' }))
    }
  }, [])

  // Connect on mount and reconnect when testFundsMode changes
  useEffect(() => {
    isUnmountingRef.current = false
    // Reset loading states when testFundsMode changes
    setState(prev => ({
      ...prev,
      fundsLoading: true,
      metricsLoading: true,
      historyLoading: true
    }))
    connect()

    return () => {
      isUnmountingRef.current = true
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
        reconnectTimeoutRef.current = null
      }
      if (wsRef.current) {
        wsRef.current.onclose = null // Prevent reconnect trigger
        wsRef.current.close()
        wsRef.current = null
      }
    }
  }, [connect])

  const value: DashboardContextValue = {
    ...state,
    refresh
  }

  return (
    <DashboardContext.Provider value={value}>
      {children}
    </DashboardContext.Provider>
  )
}

export function useDashboard() {
  const context = useContext(DashboardContext)
  if (!context) {
    throw new Error('useDashboard must be used within a DashboardProvider')
  }
  return context
}
