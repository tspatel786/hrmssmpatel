import { z } from 'zod';

const toNum = (v: unknown) => (v === '' || v === null || v === undefined ? null : Number(v));

/** Optional non-negative number input ('' -> null). */
export const optNum = (max = 1e12) => z.preprocess(toNum, z.number({ invalid_type_error: 'Enter a number' }).min(0, 'Must be 0 or more').max(max).nullable());
/** Required number input. */
export const reqNum = (min = 0, max = 1e12, msg = 'Required') =>
  z.preprocess(toNum, z.number({ required_error: msg, invalid_type_error: msg }).min(min, `Must be at least ${min}`).max(max, `Must be at most ${max}`));
export const optStr = (max = 500) => z.string().trim().max(max, `Max ${max} characters`).optional().nullable();
export const reqStr = (min = 1, max = 200, label = 'This field') => z.string().trim().min(min, `${label} is required`).max(max, `Max ${max} characters`);
export const optEmail = z.string().trim().email('Enter a valid email').or(z.literal('')).optional().nullable();
export const optUrl = z.string().trim().url('Enter a full URL (https://…)').or(z.literal('')).optional().nullable();
export const optId = z.string().optional().nullable();
export const reqId = (label = 'This field') => z.string({ required_error: `${label} is required` }).min(1, `${label} is required`);
export const reqDate = (label = 'Date') => z.string({ required_error: `${label} is required` }).min(1, `${label} is required`);
export const optDate = z.string().optional().nullable();
export const tags = z.array(z.string()).default([]);
