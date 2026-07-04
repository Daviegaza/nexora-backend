import { describe, it, expect } from 'vitest';
import {
  calcPayroll,
  calcNssf,
  calcShif,
  calcAhl,
  calcPayeBrackets,
  isValidKraPin,
} from '../src/lib/kra-tax.js';

describe('kra-tax — Kenya statutory deductions', () => {
  it('NSSF Year-4 caps at KES 6,480 each side for gross >= UEL', () => {
    const nssf = calcNssf(150_000);
    expect(nssf.employee).toBe(6_480);
    expect(nssf.employer).toBe(6_480);
  });

  it('NSSF for gross below LEL uses 6% of gross', () => {
    const nssf = calcNssf(5_000);
    expect(nssf.employee).toBe(300);
  });

  it('SHIF is 2.75% of gross with KES 300 floor', () => {
    expect(calcShif(5_000)).toBe(300); // floor kicks in (137.5 → 300)
    expect(calcShif(50_000)).toBe(1_375);
    expect(calcShif(1_000_000)).toBe(27_500); // no upper cap
  });

  it('AHL is 1.5% each side of gross', () => {
    const ahl = calcAhl(60_000);
    expect(ahl.employee).toBe(900);
    expect(ahl.employer).toBe(900);
  });

  it('PAYE bracket calc — 24k @ 10% = 2,400', () => {
    expect(calcPayeBrackets(24_000)).toBe(2_400);
  });

  it('PAYE bracket calc — 50,000 crosses first three brackets', () => {
    // 24k @ 10% = 2,400; 8,333 @ 25% = 2,083.25; remaining 17,667 @ 30% = 5,300.10 → 9,783.35
    expect(calcPayeBrackets(50_000)).toBeCloseTo(9_783.35, 1);
  });

  it('Full payroll — KES 60,000 gross typical Nairobi salary', () => {
    const bd = calcPayroll({ grossPay: 60_000 });
    expect(bd.gross).toBe(60_000);
    expect(bd.nssfEmployee).toBe(3_600); // 6% of 60k (both tiers)
    expect(bd.shif).toBe(1_650); // 2.75% of 60k
    expect(bd.ahlEmployee).toBe(900); // 1.5% of 60k
    expect(bd.personalRelief).toBe(2_400);
    expect(bd.netPay).toBeGreaterThan(0);
    expect(bd.netPay).toBeLessThan(bd.gross);
  });

  it('KRA PIN format validator', () => {
    expect(isValidKraPin('A123456789Z')).toBe(true);
    expect(isValidKraPin('P987654321Q')).toBe(true);
    expect(isValidKraPin('B123456789Z')).toBe(false); // wrong prefix
    expect(isValidKraPin('A12345678Z')).toBe(false); // too short
    expect(isValidKraPin('random')).toBe(false);
  });
});
