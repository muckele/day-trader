export function emitToast({ title, message, type = 'info', action, duration }) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('app:toast', {
    detail: { title, message, type, action, duration }
  }));
}
