// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

// CRA/Jest does not transpile axios ESM in node_modules in this setup.
// Provide a lightweight mock for component tests.
jest.mock('axios', () => {
  const mockAxios = {
    get: jest.fn(() => Promise.resolve({ data: {} })),
    post: jest.fn(() => Promise.resolve({ data: {} })),
    put: jest.fn(() => Promise.resolve({ data: {} })),
    patch: jest.fn(() => Promise.resolve({ data: {} })),
    delete: jest.fn(() => Promise.resolve({ data: {} })),
    create: jest.fn(),
    defaults: { headers: { common: {} } }
  };
  mockAxios.create.mockReturnValue(mockAxios);
  return {
    __esModule: true,
    default: mockAxios,
    ...mockAxios
  };
});
