// Test setup to suppress console warnings during tests
beforeAll(() => {
  // Mock console.warn to reduce noise from SOPS fallback messages
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterAll(() => {
  // Restore console.warn
  (console.warn as jest.Mock).mockRestore();
});