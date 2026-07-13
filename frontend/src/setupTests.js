// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';
import { vi } from 'vitest';

// Provide a lightweight Axios mock for isolated component tests.
vi.mock('axios', () => {
  const mockAxios = {
    get: vi.fn(() => Promise.resolve({ data: {} })),
    post: vi.fn(() => Promise.resolve({ data: {} })),
    put: vi.fn(() => Promise.resolve({ data: {} })),
    patch: vi.fn(() => Promise.resolve({ data: {} })),
    delete: vi.fn(() => Promise.resolve({ data: {} })),
    create: vi.fn(),
    defaults: { headers: { common: {} } }
  };
  mockAxios.create.mockReturnValue(mockAxios);
  return {
    __esModule: true,
    default: mockAxios,
    ...mockAxios
  };
});
