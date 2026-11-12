// Item form validation with the protocol field limits (spec §6.1). Pure; error messages are
// i18n keys resolved by the screen.
import type { ItemInput } from '@localvault/core';
import { FIELD } from '@localvault/protocol';
import { z } from 'zod';
import { toOpenableUrl } from './model';

export const formSchema = z.object({
  title: z
    .string()
    .trim()
    .min(FIELD.titleMin, 'form.titleRequired')
    .max(FIELD.titleMax, 'form.tooLong'),
  username: z.string().max(FIELD.usernameMax, 'form.tooLong'),
  password: z.string().max(FIELD.passwordMax, 'form.tooLong'),
  urls: z
    .array(
      z.object({
        url: z
          .string()
          .trim()
          .max(FIELD.urlMax, 'form.tooLong')
          .refine((u) => u === '' || toOpenableUrl(u) !== null, 'form.urlInvalid'),
        match: z.enum(['domain', 'host']),
      }),
    )
    .max(FIELD.urlsMax, 'form.tooManyUrls'),
  notes: z.string().max(FIELD.notesMax, 'form.tooLong'),
  favorite: z.boolean(),
});

export type FormValues = z.infer<typeof formSchema>;

export const emptyForm: FormValues = {
  title: '',
  username: '',
  password: '',
  urls: [],
  notes: '',
  favorite: false,
};

export const fieldLimits = {
  title: FIELD.titleMax,
  username: FIELD.usernameMax,
  password: FIELD.passwordMax,
  notes: FIELD.notesMax,
  urls: FIELD.urlsMax,
} as const;

/** react-hook-form resolver over zod (no extra dependency). */
export function validateForm(values: FormValues): {
  values: FormValues | Record<string, never>;
  errors: Record<string, { type: string; message: string }>;
} {
  const r = formSchema.safeParse(values);
  if (r.success) return { values: r.data, errors: {} };
  const errors: Record<string, { type: string; message: string }> = {};
  for (const issue of r.error.issues) {
    const path = issue.path.join('.');
    if (!(path in errors)) errors[path] = { type: issue.code, message: issue.message };
  }
  return { values: {}, errors };
}

/** Empty URL rows are dropped; the password is omitted when empty on edit ("unchanged"). */
export function toItemInput(v: FormValues, id?: string): ItemInput {
  const input: ItemInput = {
    ...(id ? { id } : {}),
    title: v.title.trim(),
    username: v.username,
    urls: v.urls
      .filter((u) => u.url.trim() !== '')
      .map((u) => ({ url: u.url.trim(), match: u.match })),
    notes: v.notes,
    favorite: v.favorite,
  };
  if (v.password !== '') input.password = v.password;
  return input;
}
