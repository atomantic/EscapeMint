import type { IntroStep as IntroStepType } from '../../data/intro-content'
import { Disclaimer } from './Disclaimer'
import { MarketGrowthChart } from './charts/MarketGrowthChart'
import { VolatilityComparison } from './charts/VolatilityComparison'
import { TraditionalDCAChart } from './charts/TraditionalDCAChart'
import { BuySellZones } from './charts/BuySellZones'
import { LeverageComparison } from './charts/LeverageComparison'
import { ModeComparison } from './charts/ModeComparison'
import { PathRiskChart } from './charts/PathRiskChart'

interface IntroStepProps {
  step: IntroStepType
}

export function IntroStep({ step }: IntroStepProps) {
  const renderChart = () => {
    switch (step.chartType) {
      case 'growth':
        return <MarketGrowthChart />
      case 'volatility':
        return <VolatilityComparison />
      case 'traditionalDca':
        return <TraditionalDCAChart />
      case 'buySell':
        return <BuySellZones />
      case 'leverage':
        return <LeverageComparison />
      case 'modes':
        return <ModeComparison />
      case 'pathRisk':
        return <PathRiskChart />
      case 'none':
      default:
        return null
    }
  }

  return (
    <div className="animate-fadeIn">
      {step.showDisclaimer && <Disclaimer />}

      <h2 className="text-xl sm:text-2xl md:text-3xl font-bold text-white mb-4 sm:mb-6">
        {step.title}
      </h2>

      <div className="space-y-3 sm:space-y-4 text-slate-300 text-base sm:text-lg leading-relaxed mb-6 sm:mb-8">
        {step.content.map((paragraph, i) => {
          // Handle string content with special formatting
          if (typeof paragraph === 'string') {
            // Check if it's a quote (starts with ")
            if (paragraph.startsWith('"')) {
              return (
                <blockquote key={i} className="border-l-4 border-blue-500 pl-4 italic text-slate-400 text-sm sm:text-base">
                  {paragraph}
                </blockquote>
              )
            }
            // Check if it's a list item
            if (paragraph.startsWith('•') || paragraph.startsWith('×') || paragraph.match(/^\d+\./)) {
              return (
                <p key={i} className="pl-4">
                  {paragraph}
                </p>
              )
            }
          }
          // Render ReactNode or plain string content
          return <p key={i}>{paragraph}</p>
        })}
      </div>

      {step.chartType !== 'none' && (
        <div className="mt-6 sm:mt-8 bg-slate-900/50 rounded-xl p-3 sm:p-4 border border-slate-800">
          {renderChart()}
        </div>
      )}
    </div>
  )
}
