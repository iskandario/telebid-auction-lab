import type { ValueTransformer } from 'typeorm';

export const numericTransformer: ValueTransformer = {
  to: (value: number) => value,
  from: (value: string | number) => Number(value),
};
