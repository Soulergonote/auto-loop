import { describe, expect, it } from 'vitest'
import { fmtAddress, fmtAmount, fmtDate, fmtDays, fmtDollars, fmtHf, fmtPct, fmtPrice, fmtUsd, fmtX } from './format'

// normalise the no-break spaces so the expectations stay readable
const s = (x: string) => x.replace(/[  ]/g, ' ')

describe('formats of the UI charter', () => {
  it('writes dollars with 2 decimals, "$" after, never "$US"', () => {
    expect(s(fmtDollars(2240.684))).toBe('2 240,68 $')
    expect(s(fmtUsd(150_000_000n))).toBe('1,50 $')
    expect(fmtDollars(5)).not.toMatch(/US/)
  })

  it('shortens large amounts in tables from 10 000 $', () => {
    expect(s(fmtDollars(48_312, true))).toBe('48,3 k $')
    expect(s(fmtDollars(1_400_000, true))).toBe('1,4 M $')
    expect(s(fmtDollars(9_999, true))).toBe('9 999,00 $')
  })

  it('uses the true minus sign', () => {
    expect(s(fmtPct(-0.0301))).toBe('−3,01 %')
    expect(s(fmtDollars(-12))).toBe('−12,00 $')
  })

  it('gives token amounts 4 decimals from 1 and 4 significant digits below', () => {
    expect(s(fmtAmount(1_999_312_000_000_000_000n, 18))).toBe('1,9993')
    expect(fmtAmount(79_123n, 8)).toBe('0,0007912')
    expect(fmtAmount(0n, 6)).toBe('0')
  })

  it('formats percentages, leverage, health factor and prices', () => {
    expect(s(fmtPct(0.0513))).toBe('5,13 %')
    expect(s(fmtPct(0.93, 0))).toBe('93 %')
    expect(fmtX(2)).toBe('2x')
    expect(fmtX(6.4712)).toBe('6,47x')
    expect(fmtX(7.1, true)).toBe('7,10x')
    expect(s(fmtPct(0.727))).toBe('72,70 %')
    expect(s(fmtPct(-0.02))).toBe('−2,00 %')
    expect(fmtHf(1.5)).toBe('1,50')
    expect(s(fmtAmount(2_118_900_000n, 6))).toBe('2 118,90')
    expect(fmtHf(Infinity)).toBe('∞')
    expect(s(fmtPrice(99_987_000n))).toBe('0,9999 $')
    expect(s(fmtPrice(3_012_50_000_000n))).toBe('3 012,50 $')
  })

  it('formats dates, durations and addresses', () => {
    const now = new Date('2026-11-04T00:00:00Z')
    expect(fmtDate(Date.UTC(2026, 10, 11, 12) / 1000, now)).toBe('11 nov.')
    expect(fmtDate(Date.UTC(2027, 0, 3, 12) / 1000, now)).toBe('3 janv. 2027')
    expect(s(fmtDays(90))).toBe('90 j')
    expect(s(fmtDays(180))).toBe('6 mois')
    expect(fmtAddress('0x6A0011112222333344445555666677778888106B'.slice(0, 38) + '1068')).toBe('0x6A00…1068')
  })
})
