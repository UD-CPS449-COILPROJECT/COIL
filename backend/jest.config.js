const threshold = 90;

export default {
  testEnvironment: 'node',
  transform: {},
  coverageProvider: 'v8',
  collectCoverageFrom: ['src/**/*.js'],
  coverageThreshold: {
    global: {
      statements: threshold,
      branches: threshold,
      functions: threshold,
      lines: threshold
    }
  }
};
