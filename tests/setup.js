// Test setup - runs before each test file
import 'fake-indexeddb/auto';
import { vi } from 'vitest';

// Mock crypto.randomUUID if not available
if (!globalThis.crypto?.randomUUID) {
  globalThis.crypto = {
    ...globalThis.crypto,
    randomUUID: () => 'test-uuid-' + Math.random().toString(36).slice(2),
    getRandomValues: (arr) => {
      for (let i = 0; i < arr.length; i++) {
        arr[i] = Math.floor(Math.random() * 256);
      }
      return arr;
    },
    subtle: globalThis.crypto?.subtle,
  };
}

// Mock localStorage
const localStorageMock = (() => {
  let store = {};
  return {
    getItem: (key) => store[key] || null,
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();
globalThis.localStorage = localStorageMock;

// Reset mocks and localStorage between tests
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});
