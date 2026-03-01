export interface PricePoint {
  date: string  // ISO date YYYY-MM-DD
  value: number // Equity value
}

export interface DividendPayment {
  exDate: string  // Ex-dividend date YYYY-MM-DD
  amount: number  // Per-share dividend amount
}

export interface HistoricalData {
  ticker: string
  name: string
  type: 'stock' | 'crypto'
  startDate: string
  endDate: string
  dataPoints: number
  prices: PricePoint[]
  dividends?: DividendPayment[]  // Optional dividend data (stocks only)
}

export interface DateRange {
  start: string
  end: string
}
