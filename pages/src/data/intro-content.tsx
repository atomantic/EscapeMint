import type { ReactNode } from 'react'

export interface IntroStep {
  id: number
  title: string
  content: ReactNode[]
  chartType: 'growth' | 'volatility' | 'traditionalDca' | 'buySell' | 'leverage' | 'modes' | 'pathRisk' | 'none'
  showDisclaimer?: boolean
}

export const INTRO_STEPS: IntroStep[] = [
  {
    id: 1,
    title: 'Getting Rich Slowly',
    content: [
      '"The stock market is a device for transferring money from the impatient to the patient... nobody wants to get rich slowly." — Warren Buffett',
      'Getting rich is easy, as long as you\'re willing to do it slowly.',
      'You don\'t need to watch the news, analyze earnings reports, or pick individual stocks.',
      'Remove emotion, track your position and follow the rules.'
    ],
    chartType: 'none',
    showDisclaimer: true
  },
  {
    id: 2,
    title: 'The Market Grows',
    content: [
      'The whole stock market grows at about 10% annually (long-term average).',
      'Recently, it\'s been even higher—20-40% in some years.',
      'This is the baseline we\'re building on.'
    ],
    chartType: 'growth'
  },
  {
    id: 3,
    title: 'But It\'s Not a Straight Line',
    content: [
      'However, the market doesn\'t grow in a steady straight line.',
      <>It has volatility—wild swings up and down. <span className="px-2 py-0.5 rounded-full bg-red-600/30 text-red-400 text-sm">Recessions</span> and <span className="px-2 py-0.5 rounded-full bg-green-600/30 text-green-400 text-sm">Bubbles</span>.</>,
      'And for the long-term investor, this is actually GOOD news.'
    ],
    chartType: 'volatility'
  },
  {
    id: 4,
    title: 'Traditional DCA Falls Short',
    content: [
      'Most retirement advice centers around Dollar Cost Averaging (DCA): Invest the same amount every week/month, regardless of price.',
      'But this ignores a key opportunity: when the market is super inflated, it might be better to SELL than to buy.',
      'If you expect 20% annual growth, but you\'re clocking 50% APY... then regardless of the news, the market is overvalued relative to your target. And you can lock it in.'
    ],
    chartType: 'traditionalDca'
  },
  {
    id: 5,
    title: 'Volatility is Your Friend',
    content: [
      'For the DCA investor, higher volatility is actually BETTER:',
      '• When prices are LOW → You buy MORE shares',
      '• When prices are HIGH → You can harvest profits above your target',
      'Think of it like extracting dividends from your own growth. This also gives you a constant cash pile to resume your DCA during the next recession.'
    ],
    chartType: 'buySell'
  },
  {
    id: 6,
    title: 'DCA In AND Out',
    content: [
      'This system dollar-cost-averages in BOTH directions:',
      '• DCA into dips (buy at lower prices)',
      '• DCA out of peaks (sell when above target)',
      'Rules replace emotions. No FOMO. No panic selling.'
    ],
    chartType: 'buySell'
  },
  {
    id: 7,
    title: 'Two Modes: Harvest vs Accumulate',
    content: [
      'There are two ways to manage your fund:',
      <><span className="font-bold text-green-400">Harvest Mode:</span> For cash optimization. Fully exit when above target, then slowly rebuild. Great for volatile assets like TQQQ, SPXL. This is for optimizing cash.</>,
      <><span className="font-bold text-blue-400">Accumulate Mode:</span> For long-term retirement. Take small profits, keep building your position. Great for an M1 Finance savings fund that's backed by a margin borrowing account (so you can buy → borrow → die).</>
    ],
    chartType: 'modes'
  },
  {
    id: 8,
    title: 'Buy Recessions, Sell Bubbles',
    content: [
      'In both modes, the strategy is the same:',
      'Recession → BUY more (prices are on sale)',
      'Bubble → SELL (lock in gains above target)',
      'The system tells you exactly what to do, every week/month (intervals are configurable).'
    ],
    chartType: 'buySell'
  },
  {
    id: 9,
    title: 'Choosing Your Assets',
    content: [
      <><span className="font-semibold text-blue-400">Core principle:</span> Only invest in assets that can only go to zero if the entire economy collapses. Meme stocks can go to zero. If the whole market goes to zero, you have bigger problems than your stock holdings valuation.</>,
      <><span className="font-semibold">For long-term holdings:</span> Total market indexes (VTI), Bitcoin (BTC), large-cap indexes, or mag-7 stocks. These are "hold forever" assets for retirement accounts.</>,
      <><span className="font-semibold">For cash management:</span> Leveraged ETFs like TQQQ/SPXL can be used in harvest mode if you're confident the current market regime continues—low rates, tech growth, low volatility.</>,
      'The key is matching your asset choice to your goal: stable accumulation vs. aggressive cash harvesting.',
      'And if regime conditions change, you can rebalance—that\'s the power of a rules-based system.'
    ],
    chartType: 'none'
  },
  {
    id: 10,
    title: 'Leveraged ETFs = More Volatility',
    content: [
      'Example assets used by the creator (not financial advice):',
      <><span className="font-semibold">TQQQ</span> is a 3x leveraged long on the Nasdaq-100.<br /><span className="text-xs text-slate-500">TQQQ seeks daily investment results, before fees and expenses, that correspond to three times (3x) the daily performance of the Nasdaq-100 Index.</span> <a href="https://portfolioslab.com/tools/stock-comparison/%5ENDX/TQQQ" target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:text-blue-300">Compare TQQQ vs Nasdaq-100 →</a></>,
      <><span className="font-semibold">SPXL</span> is a 3x leveraged long on the Russell 1000 Large Cap Index.<br /><span className="text-xs text-slate-500">SPXL seeks daily investment results, before fees and expenses, of 300% of the price performance of the Russell 1000 Index. There is no guarantee the fund will meet its stated investment objective.</span> <a href="https://portfolioslab.com/tools/stock-comparison/BRGNX/SPXL" target="_blank" rel="noopener noreferrer" className="text-xs text-blue-400 hover:text-blue-300">Compare SPXL vs BRGNX →</a></>,
      'More volatility = more opportunities to buy low and sell high.',
      <><span className="font-semibold text-amber-400">⚠️ Important:</span> Historical results are not guaranteed. The past decade was exceptionally favorable for leveraged ETFs—low interest rates, tech dominance, and sustained bull markets. A regime change (higher rates, stagflation, prolonged volatility) could significantly impair these products through volatility decay and higher borrowing costs.</>,
      'Your choice of assets depends on your risk tolerance and research.'
    ],
    chartType: 'leverage'
  },
  {
    id: 11,
    title: 'A Slow Bear Can Wipe Out a 3x Fund',
    content: [
      'A daily-reset 3x fund multiplies today\'s index move by three, then starts over tomorrow. It does not multiply the long-run return by three.',
      'Volatility decay is the quiet cost. A day up 10% and a day down 10% leaves the index at 99 cents on the dollar. The same round trip leaves a 3x fund at 91 cents, before fees.',
      'The risk that shows up in the record is a slow bear. Ordinary down days compound. A synthetic Nasdaq-100 3x built from real daily closes (Yahoo Finance ^NDX, 10 Mar 1999–31 Dec 2012, 0.9%/year expense) fell 99.97% from its peak, bottoming on 9 Mar 2009. The worst day in that sample was about −10.5% (29 Sep 2008). A semiconductor 3x built from the PHLX Semiconductor Index (^SOX, 4 Jan 1999–31 Dec 2012) fell 99.999% and finished at about 0.002% of its peak. After a collapse like that an issuer can close the fund or reverse-split it, so the rebound dip-buying was waiting for never arrives. That is the case the fallback is built for.',
      'A day down about a third (3 × −33% ≈ −100%) would zero a 3x fund while the stocks behind it still had about two thirds of their value. That is a stress test, not a likely day. From 1975 through Oct 2026 the S&P 500\'s worst session is −20.5% on 19 Oct 1987, about −61% for a 3x fund. The Nasdaq-100\'s worst close since 1985 is −15.1% that same day, then −12.2% on 16 Mar 2020. The semiconductor index\'s worst day since 1994 is −15.9% on 16 Mar 2020. The Russell 1000\'s worst day in the series since 1992 is −12.2%, also 16 Mar 2020. Yahoo Finance session closes. None of those days is −33%.',
      'Market-wide circuit breakers date from October 1988. Since 4 Feb 2013, a 20% drop in the S&P 500 — Level 3 — halts trading for the rest of the day. From 1988 until that change the all-day halt was a 30% drop in the Dow, and a 20% drop was a shorter halt. A −33% close is outside both the record and the current halt.',
      'The chart is that slow bear, with the same cash on three paths and no borrowing: $10,000 on the first session, then $100 every five trading days ($79,500 by the end of 2012).',
      '• 3x only finished at $98,635. Money-weighted return 2.7%/year. Time-weighted return −23%/year. Max drawdown 98.9%.',
      '• 1x fallback finished at $100,976. Money-weighted return 3.0%/year. Max drawdown 97.2%. New buys went to QQQ once the 3x fund was down 60% or ^NDX closed under its 200-day average ($63,600 of the contributions).',
      '• VTI buy-and-hold, same deposits, finished at $100,925. Money-weighted return 3.0%/year. Max drawdown 51.0%. The benchmark uses VTSMX until VTI closes begin on 15 Jun 2001.',
      'On this Nasdaq path, ending wealth is almost a tie. VTI finishes a few dollars behind the fallback, not ahead of it, and a little ahead of 3x-only. The gap that matters is the drawdown: 51% for VTI, about 99% for both leveraged paths. Later deposits clawed the 3x account back by 2012 because the synthetic fund never quite hit zero. If the issuer closes it once it is 99% off its peak, 3x-only ends at $60,446 and the fallback still ends at $101,475, just above VTI.',
      'The semiconductor path is where VTI pulls ahead of both. Same rule, ^SOX standing in for SOXX (the ETF listed in July 2001): 3x only $22,394, fallback $60,819, VTI $102,555, on $80,400 contributed. Max drawdowns 99.8%, 98.7%, and 51.1%. VTI ends ahead, with about half the drawdown.',
      'The fallback is optional and off unless you turn it on. Threshold and moving-average length are configurable (defaults: 60% and 200 days). It routes the next buy — TQQQ to QQQ, SOXL to SOXX, SPXL to SPY or VOO — and sends new buys back to the 3x fund only after the drawdown has healed and the underlying has closed back above its average. It does not sell shares you already hold, and it does not use margin. The one-day stress test still takes an existing 3x position to zero. The rule only changes where the next dollar goes.'
    ],
    chartType: 'pathRisk'
  },
  {
    id: 12,
    title: 'What This System Is NOT',
    content: [
      'This is NOT for:',
      '× Day trading meme stocks',
      '× Picking winners and losers',
      '× Betting against the market (shorting)',
      '× Apocalyptic hedging',
      'This is a long-term bet that the market goes up over decades.'
    ],
    chartType: 'none'
  },
  {
    id: 13,
    title: 'Your Personal Configuration',
    content: [
      'You control:',
      '• Target APY (10% = sell sooner, more taxable events → 40% = hold longer, accumulate more)',
      '• DCA amounts (how much to invest per period with tiers)',
      '• Check frequency (daily, weekly, monthly)',
      '• Which assets (indexes, bitcoin, leveraged ETFs, etc)',
      'This works for IRAs, 401ks, or regular trading accounts. Your taxes and goals determine your settings.'
    ],
    chartType: 'none'
  },
  {
    id: 14,
    title: 'Get Started',
    content: [
      'Ready to simulate your first fund?',
      'Try the backtest tool to see how this strategy would have performed with different assets and configurations.',
      <>For reference (not financial advice), the creator has a public M1 Finance Pie at <a href="https://m1.finance/OGMwOZn__m2e" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300">m1.finance</a> (updated from time to time).</>
    ],
    chartType: 'none',
    showDisclaimer: true
  }
]

export const TOTAL_STEPS = INTRO_STEPS.length
