import { useState } from 'react'

interface Props {
  spxlPct: number
  vtiPct: number
  brgnxPct: number
  tqqqPct: number
  btcPct: number
  gldPct: number
  slvPct: number
  onChange: (spxlPct: number, vtiPct: number, brgnxPct: number, tqqqPct: number, btcPct: number, gldPct: number, slvPct: number) => void
}

type AssetKey = 'SPXL' | 'VTI' | 'BRGNX' | 'TQQQ' | 'BTC' | 'GLD' | 'SLV'

export function PieBuilder({ spxlPct, vtiPct, brgnxPct, tqqqPct, btcPct, gldPct, slvPct, onChange }: Props) {
  const total = spxlPct + vtiPct + brgnxPct + tqqqPct + btcPct + gldPct + slvPct
  const [locked, setLocked] = useState<Record<AssetKey, boolean>>({
    SPXL: false,
    VTI: false,
    BRGNX: false,
    TQQQ: false,
    BTC: false,
    GLD: false,
    SLV: false
  })

  const toggleLock = (asset: AssetKey) => {
    setLocked(prev => ({ ...prev, [asset]: !prev[asset] }))
  }

  const handleChange = (asset: AssetKey, value: number) => {
    let newSpxl = spxlPct
    let newVti = vtiPct
    let newBrgnx = brgnxPct
    let newTqqq = tqqqPct
    let newBtc = btcPct
    let newGld = gldPct
    let newSlv = slvPct

    if (asset === 'SPXL') newSpxl = value
    else if (asset === 'VTI') newVti = value
    else if (asset === 'BRGNX') newBrgnx = value
    else if (asset === 'TQQQ') newTqqq = value
    else if (asset === 'BTC') newBtc = value
    else if (asset === 'GLD') newGld = value
    else newSlv = value

    const newTotal = newSpxl + newVti + newBrgnx + newTqqq + newBtc + newGld + newSlv
    const diff = newTotal - 100

    if (diff !== 0) {
      const unlocked: { asset: AssetKey; val: number }[] = []
      if (asset !== 'SPXL' && !locked.SPXL) unlocked.push({ asset: 'SPXL', val: newSpxl })
      if (asset !== 'VTI' && !locked.VTI) unlocked.push({ asset: 'VTI', val: newVti })
      if (asset !== 'BRGNX' && !locked.BRGNX) unlocked.push({ asset: 'BRGNX', val: newBrgnx })
      if (asset !== 'TQQQ' && !locked.TQQQ) unlocked.push({ asset: 'TQQQ', val: newTqqq })
      if (asset !== 'BTC' && !locked.BTC) unlocked.push({ asset: 'BTC', val: newBtc })
      if (asset !== 'GLD' && !locked.GLD) unlocked.push({ asset: 'GLD', val: newGld })
      if (asset !== 'SLV' && !locked.SLV) unlocked.push({ asset: 'SLV', val: newSlv })

      const unlockedTotal = unlocked.reduce((sum, u) => sum + u.val, 0)

      if (unlocked.length > 0 && (unlockedTotal > 0 || diff < 0)) {
        for (const u of unlocked) {
          const adjust = unlockedTotal > 0
            ? (diff * u.val / unlockedTotal)
            : (diff / unlocked.length)
          const newVal = Math.max(0, Math.min(100, u.val - adjust))
          if (u.asset === 'SPXL') newSpxl = newVal
          else if (u.asset === 'VTI') newVti = newVal
          else if (u.asset === 'BRGNX') newBrgnx = newVal
          else if (u.asset === 'TQQQ') newTqqq = newVal
          else if (u.asset === 'BTC') newBtc = newVal
          else if (u.asset === 'GLD') newGld = newVal
          else newSlv = newVal
        }
      }
    }

    newSpxl = Math.round(newSpxl)
    newVti = Math.round(newVti)
    newBrgnx = Math.round(newBrgnx)
    newTqqq = Math.round(newTqqq)
    newBtc = Math.round(newBtc)
    newGld = Math.round(newGld)
    newSlv = Math.round(newSlv)

    const finalTotal = newSpxl + newVti + newBrgnx + newTqqq + newBtc + newGld + newSlv
    if (finalTotal !== 100) {
      const adjust = 100 - finalTotal
      const adjustable = [
        { asset: 'SPXL' as AssetKey, val: newSpxl, canAdjust: asset !== 'SPXL' && !locked.SPXL },
        { asset: 'VTI' as AssetKey, val: newVti, canAdjust: asset !== 'VTI' && !locked.VTI },
        { asset: 'BRGNX' as AssetKey, val: newBrgnx, canAdjust: asset !== 'BRGNX' && !locked.BRGNX },
        { asset: 'TQQQ' as AssetKey, val: newTqqq, canAdjust: asset !== 'TQQQ' && !locked.TQQQ },
        { asset: 'BTC' as AssetKey, val: newBtc, canAdjust: asset !== 'BTC' && !locked.BTC },
        { asset: 'GLD' as AssetKey, val: newGld, canAdjust: asset !== 'GLD' && !locked.GLD },
        { asset: 'SLV' as AssetKey, val: newSlv, canAdjust: asset !== 'SLV' && !locked.SLV }
      ].filter(a => a.canAdjust).sort((a, b) => b.val - a.val)

      if (adjustable.length > 0) {
        const target = adjustable[0]!
        if (target.asset === 'SPXL') newSpxl += adjust
        else if (target.asset === 'VTI') newVti += adjust
        else if (target.asset === 'BRGNX') newBrgnx += adjust
        else if (target.asset === 'TQQQ') newTqqq += adjust
        else if (target.asset === 'BTC') newBtc += adjust
        else if (target.asset === 'GLD') newGld += adjust
        else newSlv += adjust
      }
    }

    onChange(newSpxl, newVti, newBrgnx, newTqqq, newBtc, newGld, newSlv)
  }

  return (
    <div className="space-y-1.5">
      {/* Visual bar */}
      <div className="h-5 rounded overflow-hidden flex">
        {spxlPct > 0 && (
          <div
            className="flex items-center justify-center text-[9px] text-white font-medium gap-1"
            style={{ width: `${spxlPct}%`, backgroundColor: '#3b82f6' }}
            title={`SPXL: ${spxlPct}%`}
          >
            {spxlPct > 20 ? `SPXL ${spxlPct}%` : spxlPct > 10 ? `${spxlPct}%` : ''}
          </div>
        )}
        {vtiPct > 0 && (
          <div
            className="flex items-center justify-center text-[9px] text-white font-medium gap-1"
            style={{ width: `${vtiPct}%`, backgroundColor: '#8b5cf6' }}
            title={`VTI: ${vtiPct}%`}
          >
            {vtiPct > 20 ? `VTI ${vtiPct}%` : vtiPct > 10 ? `${vtiPct}%` : ''}
          </div>
        )}
        {brgnxPct > 0 && (
          <div
            className="flex items-center justify-center text-[9px] text-white font-medium gap-1"
            style={{ width: `${brgnxPct}%`, backgroundColor: '#06b6d4' }}
            title={`BRGNX: ${brgnxPct}%`}
          >
            {brgnxPct > 20 ? `BRGNX ${brgnxPct}%` : brgnxPct > 10 ? `${brgnxPct}%` : ''}
          </div>
        )}
        {tqqqPct > 0 && (
          <div
            className="flex items-center justify-center text-[9px] text-white font-medium gap-1"
            style={{ width: `${tqqqPct}%`, backgroundColor: '#22c55e' }}
            title={`TQQQ: ${tqqqPct}%`}
          >
            {tqqqPct > 20 ? `TQQQ ${tqqqPct}%` : tqqqPct > 10 ? `${tqqqPct}%` : ''}
          </div>
        )}
        {btcPct > 0 && (
          <div
            className="flex items-center justify-center text-[9px] text-white font-medium gap-1"
            style={{ width: `${btcPct}%`, backgroundColor: '#f97316' }}
            title={`BTC: ${btcPct}%`}
          >
            {btcPct > 20 ? `BTC ${btcPct}%` : btcPct > 10 ? `${btcPct}%` : ''}
          </div>
        )}
        {gldPct > 0 && (
          <div
            className="flex items-center justify-center text-[9px] text-white font-medium gap-1"
            style={{ width: `${gldPct}%`, backgroundColor: '#eab308' }}
            title={`GLD: ${gldPct}%`}
          >
            {gldPct > 20 ? `GLD ${gldPct}%` : gldPct > 10 ? `${gldPct}%` : ''}
          </div>
        )}
        {slvPct > 0 && (
          <div
            className="flex items-center justify-center text-[9px] text-white font-medium gap-1"
            style={{ width: `${slvPct}%`, backgroundColor: '#94a3b8' }}
            title={`SLV: ${slvPct}%`}
          >
            {slvPct > 20 ? `SLV ${slvPct}%` : slvPct > 10 ? `${slvPct}%` : ''}
          </div>
        )}
      </div>

      {/* Sliders */}
      <div className="space-y-1">
        <SliderControl label="SPXL" value={spxlPct} onChange={(v) => handleChange('SPXL', v)} color="#3b82f6" locked={locked.SPXL} onToggleLock={() => toggleLock('SPXL')} />
        <SliderControl label="VTI" value={vtiPct} onChange={(v) => handleChange('VTI', v)} color="#8b5cf6" locked={locked.VTI} onToggleLock={() => toggleLock('VTI')} />
        <SliderControl label="BRGNX" value={brgnxPct} onChange={(v) => handleChange('BRGNX', v)} color="#06b6d4" locked={locked.BRGNX} onToggleLock={() => toggleLock('BRGNX')} />
        <SliderControl label="TQQQ" value={tqqqPct} onChange={(v) => handleChange('TQQQ', v)} color="#22c55e" locked={locked.TQQQ} onToggleLock={() => toggleLock('TQQQ')} />
        <SliderControl label="BTC" value={btcPct} onChange={(v) => handleChange('BTC', v)} color="#f97316" locked={locked.BTC} onToggleLock={() => toggleLock('BTC')} />
        <SliderControl label="GLD" value={gldPct} onChange={(v) => handleChange('GLD', v)} color="#eab308" locked={locked.GLD} onToggleLock={() => toggleLock('GLD')} />
        <SliderControl label="SLV" value={slvPct} onChange={(v) => handleChange('SLV', v)} color="#94a3b8" locked={locked.SLV} onToggleLock={() => toggleLock('SLV')} />
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
      <span className="text-[10px] text-slate-400 w-9">{label}</span>
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
