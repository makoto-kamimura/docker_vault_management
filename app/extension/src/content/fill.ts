// Filling (12.6-4): native value setter + input/change events (works with React & friends).
import { isVisible } from './visibility';

export function setNativeValue(el: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as object;
  const desc =
    Object.getOwnPropertyDescriptor(proto, 'value') ??
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (desc?.set) desc.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export type FillOutcome = { filled: number; refusedInvisible: number };

/**
 * Fills the given pairs, but only into fields that are visible RIGHT NOW (re-checked at fill time,
 * not at detection time). Never called except from a user click.
 */
export function fillFields(
  pairs: { el: HTMLInputElement | null; value: string | undefined }[],
): FillOutcome {
  let filled = 0;
  let refusedInvisible = 0;
  for (const { el, value } of pairs) {
    if (el === null || value === undefined) continue;
    if (!el.isConnected || !isVisible(el)) {
      refusedInvisible++;
      continue;
    }
    setNativeValue(el, value);
    filled++;
  }
  return { filled, refusedInvisible };
}
