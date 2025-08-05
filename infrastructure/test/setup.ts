// Test setup to suppress console warnings during tests
let consoleWarnMock: jest.SpyInstance;

beforeAll(() => {
  // Mock console.warn to reduce noise from SOPS fallback messages
  consoleWarnMock = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  // Restore console.warn
  if (consoleWarnMock) {
    consoleWarnMock.mockRestore();
  }
});