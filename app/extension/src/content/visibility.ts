// "Never fill invisible fields" (12.6-5): zero size, display:none, visibility:hidden,
// opacity 0 (own or any ancestor's) and off-screen are all treated as invisible.

const MIN_SIDE_PX = 5;

export function isVisible(el: Element): boolean {
  const win = el.ownerDocument.defaultView;
  if (win === null) return false;
  if (el instanceof win.HTMLInputElement && el.type === 'hidden') return false;
  if (el.hasAttribute('hidden')) return false;

  const style = win.getComputedStyle(el);
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;

  // opacity is not inherited but an invisible ancestor hides its subtree; walk up (shadow-aware).
  let node: Node | null = el;
  while (node !== null) {
    if (node instanceof win.Element) {
      const s = win.getComputedStyle(node);
      if (s.display === 'none') return false;
      if (Number.parseFloat(s.opacity === '' ? '1' : s.opacity) === 0) return false;
      if (node.hasAttribute('hidden')) return false;
    }
    const parent: Node | null = node.parentNode;
    node = parent instanceof win.ShadowRoot ? parent.host : parent;
  }

  const rect = el.getBoundingClientRect();
  if (rect.width < MIN_SIDE_PX || rect.height < MIN_SIDE_PX) return false;
  const doc = el.ownerDocument.documentElement;
  const left = rect.left + win.scrollX;
  const top = rect.top + win.scrollY;
  // Left of / above the page origin can never be scrolled to; far right of the layout viewport is a trap too.
  if (left + rect.width <= 0 || top + rect.height <= 0) return false;
  if (left >= Math.max(win.innerWidth, doc.clientWidth) && win.innerWidth > 0) return false;
  return true;
}
