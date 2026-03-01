import type { DateRange } from './types'

interface DateRangePickerProps {
  availableRange: DateRange
  selectedRange: DateRange
  onChange: (range: DateRange) => void
}

export function DateRangePicker({ availableRange, selectedRange, onChange }: DateRangePickerProps) {
  const handleStartChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newStart = e.target.value
    if (newStart <= selectedRange.end) {
      onChange({ ...selectedRange, start: newStart })
    }
  }

  const handleEndChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newEnd = e.target.value
    if (newEnd >= selectedRange.start) {
      onChange({ ...selectedRange, end: newEnd })
    }
  }

  const handlePreset = (preset: 'all' | '1y' | '2y' | '3y' | '4y' | 'ytd') => {
    const end = availableRange.end
    let start = availableRange.start

    if (preset === '1y') {
      const endDate = new Date(end)
      endDate.setFullYear(endDate.getFullYear() - 1)
      start = endDate.toISOString().split('T')[0]!
      if (start < availableRange.start) start = availableRange.start
    } else if (preset === '2y') {
      const endDate = new Date(end)
      endDate.setFullYear(endDate.getFullYear() - 2)
      start = endDate.toISOString().split('T')[0]!
      if (start < availableRange.start) start = availableRange.start
    } else if (preset === '3y') {
      const endDate = new Date(end)
      endDate.setFullYear(endDate.getFullYear() - 3)
      start = endDate.toISOString().split('T')[0]!
      if (start < availableRange.start) start = availableRange.start
    } else if (preset === '4y') {
      const endDate = new Date(end)
      endDate.setFullYear(endDate.getFullYear() - 4)
      start = endDate.toISOString().split('T')[0]!
      if (start < availableRange.start) start = availableRange.start
    } else if (preset === 'ytd') {
      const endDate = new Date(end)
      start = `${endDate.getFullYear()}-01-01`
      if (start < availableRange.start) start = availableRange.start
    }

    onChange({ start, end })
  }

  const daysBetween = Math.floor(
    (new Date(selectedRange.end).getTime() - new Date(selectedRange.start).getTime()) / (1000 * 60 * 60 * 24)
  )
  const years = (daysBetween / 365).toFixed(1)

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <div className="flex items-center gap-2">
        <input
          type="date"
          value={selectedRange.start}
          min={availableRange.start}
          max={selectedRange.end}
          onChange={handleStartChange}
          className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
        />
        <span className="text-slate-500">to</span>
        <input
          type="date"
          value={selectedRange.end}
          min={selectedRange.start}
          max={availableRange.end}
          onChange={handleEndChange}
          className="bg-slate-700 border border-slate-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-slate-400">
          <span className="text-white">{daysBetween}</span>d ({years}y)
        </span>
        <div className="flex items-center gap-1">
          {(['ytd', '1y', '2y', '3y', '4y', 'all'] as const).map(preset => (
            <button
              key={preset}
              onClick={() => handlePreset(preset)}
              className="px-1.5 py-0.5 text-[10px] bg-slate-700 hover:bg-slate-600 rounded transition-colors uppercase cursor-pointer"
            >
              {preset}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
