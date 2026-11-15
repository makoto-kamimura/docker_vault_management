import {
  GENERATOR_MAX_LENGTH,
  GENERATOR_MIN_LENGTH,
  type GeneratorOptions,
} from '@localvault/core';

export const classKeys = ['upper', 'lower', 'digits', 'symbols'] as const;

export function clampLength(n: number): number {
  return Math.min(GENERATOR_MAX_LENGTH, Math.max(GENERATOR_MIN_LENGTH, Math.round(n)));
}

/** At least one character class must stay selected. */
export function canDisable(o: GeneratorOptions, key: (typeof classKeys)[number]): boolean {
  return classKeys.filter((k) => k !== key && o[k]).length > 0;
}
