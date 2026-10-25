import { useState } from 'react'

export interface PieAllocation {
  spxlPct: number
  vtiPct: number
  brgnxPct: number
  tqqqPct: number
  btcPct: number
  gldPct: number
  slvPct: number
  qqqPct: number
  soxxPct: number
  soxlPct: number
}

interface Props extends PieAllocation {
  onChange: (allocation: PieAllocation) => void
}

const ASSETS = [
  { key: 'SPXL', field: 'spxlPct', color: '#3b82f6' },
  { key: 'VTI', field: 'vtiPct', color: '#8b5cf6' },
  { key: 'BRGNX', field: 'brgnxPct', color: '#06b6d4' },
  { key: 'TQQQ', field: 'tqqqPct', color: '#22c55e' },
  { key: 'QQQ', field: 'qqqPct', color: '#38bdf8' },
  { key: 'SOXL', field: 'soxlPct', color: '#fb7185' },
  { key: 'SOXX', field: 'soxxPct', color: '#a78bfa' },
  { key: 'BTC', field: 'btcPct', color: '#f97316' },
  { key: 'GLD', field: 'gldPct', color: '#eab308' },
  { key: 'SLV', field: 'slvPct', color: '#94a3b8' }
] as const

type AssetKey = (typeof ASSETS)[number]['key']

export function PieBuilder(props: Props) {
  const { onChange } = props
  const values: Record<AssetKey, number> = {
    SPXL: props.spxlPct,
    VTI: props.vtiPct,
    BRGNX: props.brgnxPct,
    TQQQ: props.tqqqPct,
    QQQ: props.qqqPct,
    SOXL: props.soxlPct,
    SOXX: props.soxxPct,
    BTC: props.btcPct,
    GLD: props.gldPct,
    SLV: props.slvPct
  }
  const total = ASSETS.reduce((sum, asset) => sum + values[asset.key], 0)
  const [locked, setLocked] = useState<Record<AssetKey, boolean>>({
    SPXL: false,
    VTI: false,
    BRGNX: false,
    TQQQ: false,
    QQQ: false,
    SOXL: false,
    SOXX: false,
    BTC: false,
    GLD: false,
    SLV: false
  })

  const toggleLock = (asset: AssetKey) => {
    setLocked(prev => ({ ...prev, [asset]: !prev[asset] }))
  }

  const emit = (next: Record<AssetKey, number>) => {
    onChange({
      spxlPct: next.SPXL,
      vtiPct: next.VTI,
      brgnxPct: next.BRGNX,
      tqqqPct: next.TQQQ,
      qqqPct: next.QQQ,
      soxlPct: next.SOXL,
      soxxPct: next.SOXX,
      btcPct: next.BTC,
      gldPct: next.GLD,
      slvPct: next.SLV
    })
  }

  const handleChange = (asset: AssetKey, value: number) => {
    const next: Record<AssetKey, number> = { ...values, [asset]: value }
    const diff = ASSETS.reduce((sum, item) => sum + next[item.key], 0) - 100

    if (diff !== 0) {
      const unlocked = ASSETS.filter(item => item.key !== asset && !locked[item.key])
      const unlockedTotal = unlocked.reduce((sum, item) => sum + next[item.key], 0)
      if (unlocked.length > 0 && (unlockedTotal > 0 || diff < 0)) {
        for (const item of unlocked) {
          const adjust = unlockedTotal > 0
            ? (diff * next[item.key] / unlockedTotal)
            : (diff / unlocked.length)
          next[item.key] = Math.max(0, Math.min(100, next[item.key] - adjust))
        }
      }
    }

    for (const item of ASSETS) next[item.key] = Math.round(next[item.key])

    const finalTotal = ASSETS.reduce((sum, item) => sum + next[item.key], 0)
    if (finalTotal !== 100) {
      const adjustable = ASSETS
        .filter(item => item.key !== asset && !locked[item.key])
        .sort((a, b) => next[b.key] - next[a.key])
      const target = adjustable[0]
      if (target) next[target.key] += 100 - finalTotal
    }

    emit(next)
  }

  return (
    <div className="space-y-1.5">
      <div className="h-5 rounded overflow-hidden flex">
        {ASSETS.map(asset => values[asset.key] > 0 && (
          <div
            key={asset.key}
            className="flex items-center justify-center text-[9px] text-white font-medium gap-1"
            style={{ width: `${values[asset.key]}%`, backgroundColor: asset.color }}
            title={`${asset.key}: ${values[asset.key]}%`}
          >
            {values[asset.key] > 20 ? `${asset.key} ${values[asset.key]}%` : values[asset.key] > 10 ? `${values[asset.key]}%` : ''}
          </div>
        ))}
      </div>

      <div className="space-y-1">
        {ASSETS.map(asset => (
          <SliderControl
            key={asset.key}
            label={asset.key}
            value={values[asset.key]}
            onChange={(v) => handleChange(asset.key, v)}
            color={asset.color}
            locked={locked[asset.key]}
            onToggleLock={() => toggleLock(asset.key)}
          />
        ))}
      </div>

      {total !== 100 && (
        <div className="text-[10px] text-yellow-400">
          Must total 100%
        </div>
      )}
    </div>
  )
}

interface SliderControlProps {
  label: string
  value: number
  onChange: (value: number) => void
  color: string
  locked: boolean
  onToggleLock: () => void
}

function SliderControl({ label, value, onChange, color, locked, onToggleLock }: SliderControlProps) {
  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={onToggleLock}
        className={`w-4 h-4 flex items-center justify-center rounded text-[10px] transition-colors cursor-pointer ${
          locked ? 'bg-yellow-600 text-white' : 'bg-slate-600 text-slate-400 hover:bg-slate-500'
        }`}
        title={locked ? 'Unlock' : 'Lock'}
      >
        {locked ? '\u{1F512}' : '\u{1F513}'}
      </button>
      <span className="text-[10px] text-slate-400 w-10">{label}</span>
      <input
        type="range"
        min="0"
        max="100"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 cursor-pointer"
        style={{
          background: `linear-gradient(to right, ${color} 0%, ${color} ${value}%, #334155 ${value}%, #334155 100%)`,
          height: '6px',
          borderRadius: '3px'
        }}
      />
      <span className="text-[10px] text-slate-300 font-mono w-7 text-right">{value}%</span>
    </div>
  )
}
