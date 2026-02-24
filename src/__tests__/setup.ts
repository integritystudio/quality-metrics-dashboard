import '@testing-library/jest-dom/vitest';

// Recharts uses ResizeObserver — provide a minimal stub for jsdom
if (typeof window !== 'undefined' && !('ResizeObserver' in window)) {
  (window as unknown as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
