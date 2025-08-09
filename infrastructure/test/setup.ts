// Test setup to suppress console outputs during tests
let consoleWarnMock: jest.SpyInstance;
let consoleLogMock: jest.SpyInstance;

beforeAll(() => {
  // Mock console.warn to reduce noise from SOPS fallback messages
  consoleWarnMock = jest.spyOn(console, 'warn').mockImplementation(() => {});
  
  // Mock console.log to reduce noise from infrastructure deployment messages
  consoleLogMock = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
  // Restore console methods
  if (consoleWarnMock) {
    consoleWarnMock.mockRestore();
  }
  if (consoleLogMock) {
    consoleLogMock.mockRestore();
  }
});