# Unreleased Changes

## Added

- Optional 1x fallback for daily-reset 3x funds, off unless a fund turns it on. New buys route to the 1x ticker (TQQQ to QQQ, SOXL to SOXX, SPXL to SPY or VOO) while the fund is down 60% or its underlying is below a 200-day average. Threshold and average length are configurable. Existing shares are not sold, and the rule does not use margin.
- Weekly sample prices for QQQ, SOXX, and SOXL (Yahoo Finance session closes, retrieved 2026-10-25), plus an intro section on volatility decay and the 1999–2012 bear. The one-day one-third crash is shown as a stress test. The section compares 3x-only, the fallback, and buy-and-hold VTI, including max drawdown.

## Changed

- README now points to the native iOS/iPadOS/macOS App Store release as the actively maintained version, with a link to escapemint.shadowpuppet.net for marketing details.

## Fixed

## Removed
