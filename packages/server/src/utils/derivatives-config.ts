import type { SubFundConfig } from '@escapemint/engine'

export const getDerivativesConfig = (config: SubFundConfig) => ({
  contractMultiplier: config.contract_multiplier ?? 0.01,
  maintenanceMarginRate: config.maintenance_margin_rate ?? 0.20,
  initialMarginRate: config.initial_margin_rate ?? 0.25
})
