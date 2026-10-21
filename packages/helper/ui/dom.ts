// Small DOM helpers shared by the Control Center's tabs.

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(message: string): void {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2200);
}

export async function copy(text: string, what = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what} to the clipboard`);
  } catch {
    toast('Copy failed. Select the text and press Ctrl+C.');
  }
}

/** Hides all but the first few characters of a secret. */
export function mask(secret: string): string {
  return secret.slice(0, 4) + '•'.repeat(Math.max(8, secret.length - 4));
}
