import '@testing-library/jest-dom/vitest'

// Load .env so integration tests can reach the real services. Unit tests never read
// these; they inject fakes. Guarded so a missing .env is not fatal.
try {
  process.loadEnvFile?.('.env')
} catch {
  // no .env present — integration suites self-skip
}
