/**
 * Jest config for an ESM ("type": "module") project.
 *
 * The `test` script passes --experimental-vm-modules, which is what lets Jest
 * load native ES modules. Without this config file Jest was silently matching
 * nothing, so `npm test` reported success while running zero assertions.
 */
export default {
  testEnvironment: 'node',
  // Native ESM: no Babel transform. Files are loaded as-is.
  transform: {},
  testMatch: ['**/src/**/*.test.js'],
  setupFilesAfterEnv: ['<rootDir>/src/tests/setup.js'],
  // Mongo binary download on first run can be slow.
  testTimeout: 30000,
  // The suites share one in-memory server; running files in parallel against
  // the same database causes cross-test interference.
  maxWorkers: 1,
  collectCoverageFrom: ['src/**/*.js', '!src/**/*.test.js', '!src/tests/**'],
};
