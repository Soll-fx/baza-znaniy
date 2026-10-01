import type { Calculator } from './types';
import { vat } from './calculators/vat';
import { payroll } from './calculators/payroll';
import { profit } from './calculators/profit';
import { regimes } from './calculators/regimes';
import { social } from './calculators/social';
import { capital } from './calculators/capital';
import { excise } from './calculators/excise';
import { minimums } from './calculators/minimums';

export const CALCULATORS: Calculator[] = [
  vat,
  payroll,
  profit,
  regimes,
  social,
  capital,
  excise,
  minimums,
];

export function findCalculator(id: string): Calculator | undefined {
  return CALCULATORS.find((c) => c.id === id);
}
