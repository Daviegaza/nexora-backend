// Kenya statutory payroll deductions (2026 rates).
// All amounts in KES per month. Pure functions — no I/O.
//
// Sources:
//  - KRA PAYE brackets: Income Tax Act 2023 as amended by Finance Act 2023
//  - SHIF (Social Health Insurance Fund): SHIA Regulations 2024 — 2.75% of gross,
//    minimum KES 300, no upper cap (replaced NHIF Oct 2024).
//  - AHL (Affordable Housing Levy): 1.5% employee + 1.5% employer (Finance Act 2023).
//  - NSSF Act 2013 Year 4 rates (Feb 2026): LEL 9,000, UEL 108,000 — 6% each side,
//    max KES 6,480/side.
//  - Personal relief: KES 2,400/month (KES 28,800/year).
//
// Rates are versioned via KraTaxYear so we can roll forward when Finance Act changes.

export type KraTaxYear = 2024 | 2025 | 2026;

export interface PayrollInput {
  grossPay: number; // KES/month
  pension?: number; // employee pension contribution (allowable up to KES 30,000/mo)
  insuranceRelief?: number; // life-insurance premium/mo (relief up to 15%, cap KES 5k/mo)
  mortgageInterest?: number; // owner-occupied mortgage interest/mo (cap KES 25k/mo)
  taxYear?: KraTaxYear;
}

export interface PayrollBreakdown {
  gross: number;
  // Employee-side statutory deductions
  nssfEmployee: number;
  shif: number;
  ahlEmployee: number;
  // Reliefs
  personalRelief: number;
  insuranceReliefApplied: number;
  // PAYE
  taxableIncome: number;
  payeGross: number;
  payeNet: number;
  // Employer-side statutory contributions (not deducted from employee)
  nssfEmployer: number;
  ahlEmployer: number;
  nitaEmployer: number;
  // Bottom line
  totalEmployeeDeductions: number;
  netPay: number;
  employerCost: number;
}

const PERSONAL_RELIEF_MONTHLY = 2_400;
const INSURANCE_RELIEF_RATE = 0.15;
const INSURANCE_RELIEF_CAP = 5_000;
const MORTGAGE_INTEREST_CAP = 25_000;
const PENSION_CAP = 30_000;
const NITA_LEVY = 50; // KES 50/employee/month if >= 1 employee

// PAYE brackets (monthly, 2024+ Finance Act). Ordered ascending.
const PAYE_BRACKETS_MONTHLY: Array<{ upTo: number; rate: number }> = [
  { upTo: 24_000, rate: 0.1 },
  { upTo: 32_333, rate: 0.25 },
  { upTo: 500_000, rate: 0.3 },
  { upTo: 800_000, rate: 0.325 },
  { upTo: Infinity, rate: 0.35 },
];

// NSSF Year-4 tiers (Feb 2026 → Jan 2027).
const NSSF_LEL = 9_000;
const NSSF_UEL = 108_000;
const NSSF_RATE = 0.06;

const SHIF_RATE = 0.0275;
const SHIF_MIN = 300;

const AHL_RATE = 0.015;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function calcNssf(gross: number): { employee: number; employer: number } {
  const pensionableTier1 = Math.min(gross, NSSF_LEL);
  const pensionableTier2 = Math.max(0, Math.min(gross, NSSF_UEL) - NSSF_LEL);
  const total = (pensionableTier1 + pensionableTier2) * NSSF_RATE;
  return { employee: round2(total), employer: round2(total) };
}

export function calcShif(gross: number): number {
  return round2(Math.max(gross * SHIF_RATE, SHIF_MIN));
}

export function calcAhl(gross: number): { employee: number; employer: number } {
  const each = round2(gross * AHL_RATE);
  return { employee: each, employer: each };
}

export function calcPayeBrackets(taxable: number): number {
  let remaining = Math.max(0, taxable);
  let tax = 0;
  let lastCap = 0;
  for (const { upTo, rate } of PAYE_BRACKETS_MONTHLY) {
    const slice = Math.min(remaining, upTo - lastCap);
    if (slice <= 0) break;
    tax += slice * rate;
    remaining -= slice;
    lastCap = upTo;
    if (remaining <= 0) break;
  }
  return round2(tax);
}

export function calcPayroll(input: PayrollInput): PayrollBreakdown {
  const gross = Math.max(0, input.grossPay);
  const nssf = calcNssf(gross);
  const shif = calcShif(gross);
  const ahl = calcAhl(gross);

  const pension = Math.min(Math.max(0, input.pension ?? 0), PENSION_CAP);
  const mortgage = Math.min(Math.max(0, input.mortgageInterest ?? 0), MORTGAGE_INTEREST_CAP);

  // Allowable pre-tax deductions per KRA (Post-Finance-Act 2023).
  const preTax = nssf.employee + shif + ahl.employee + pension + mortgage;
  const taxableIncome = round2(Math.max(0, gross - preTax));

  const payeGross = calcPayeBrackets(taxableIncome);
  const insuranceReliefApplied = round2(
    Math.min((input.insuranceRelief ?? 0) * INSURANCE_RELIEF_RATE, INSURANCE_RELIEF_CAP),
  );
  const payeNet = round2(Math.max(0, payeGross - PERSONAL_RELIEF_MONTHLY - insuranceReliefApplied));

  const totalEmployeeDeductions = round2(nssf.employee + shif + ahl.employee + pension + payeNet);
  const netPay = round2(gross - totalEmployeeDeductions);
  const employerCost = round2(gross + nssf.employer + ahl.employer + NITA_LEVY);

  return {
    gross,
    nssfEmployee: nssf.employee,
    shif,
    ahlEmployee: ahl.employee,
    personalRelief: PERSONAL_RELIEF_MONTHLY,
    insuranceReliefApplied,
    taxableIncome,
    payeGross,
    payeNet,
    nssfEmployer: nssf.employer,
    ahlEmployer: ahl.employer,
    nitaEmployer: NITA_LEVY,
    totalEmployeeDeductions,
    netPay,
    employerCost,
  };
}

// KE-format PIN: A|P + 9 digits + single trailing letter. Example: A123456789Z.
export const KRA_PIN_REGEX = /^[AP]\d{9}[A-Z]$/;

export function isValidKraPin(pin: string): boolean {
  return KRA_PIN_REGEX.test(pin);
}
