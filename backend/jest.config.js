export default {
  testEnvironment: 'node',
  transform: {},
  coverageProvider: 'v8',
  collectCoverageFrom: ['src/**/*.js'],
  coverageThreshold: {
    global: {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100
    }
  }
};
