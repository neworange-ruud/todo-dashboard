import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { GRAPH_USER_PRINCIPAL_NAME, TIMEZONE, LINEAR_TEAM_KEY } from '../lib/config'

/**
 * Guards for the single-identity constraint (PRD §17.8).
 *
 * The Graph credential holds `Calendars.Read.All`, a tenant-wide application permission.
 * The hard-coded UPN constant is therefore the only thing preventing Task Desk from reading
 * someone else's calendar. These tests are source-level guards: they fail if a future change
 * makes the mailbox configurable, parameterised, or influenced by request input.
 *
 * If one of these fails, do not "fix" the test — re-read PRD §17.8 first.
 */

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) acc.push(full)
  }
  return acc
}

const ROOT = join(__dirname, '..')
const LIB = join(ROOT, 'lib')
const APP = join(ROOT, 'app')

describe('single-identity constraint', () => {
  it('pins the mailbox to one address', () => {
    expect(GRAPH_USER_PRINCIPAL_NAME).toBe('ruud.vanfalier@neworange.agency')
  })

  it('is a compile-time constant, not environment-driven', () => {
    const src = readFileSync(join(LIB, 'config.ts'), 'utf8')
    const line = src
      .split('\n')
      .find((l) => l.includes('export const GRAPH_USER_PRINCIPAL_NAME'))
    expect(line, 'the UPN declaration must exist').toBeDefined()
    // The literal must be inline — not read from process.env, not computed.
    expect(line).toContain("'ruud.vanfalier@neworange.agency'")
    expect(line).not.toMatch(/process\.env/)
  })

  it('no source file reads the mailbox from the environment', () => {
    const offenders: string[] = []
    for (const file of [...sourceFiles(LIB), ...sourceFiles(APP)]) {
      const src = readFileSync(file, 'utf8')
      if (/process\.env\.\w*(UPN|USER_PRINCIPAL|MAILBOX|GRAPH_USER)/i.test(src)) {
        offenders.push(file.replace(ROOT + '/', ''))
      }
    }
    expect(offenders, 'mailbox must never come from env').toEqual([])
  })

  it('no Graph-facing function accepts a mailbox or user parameter', () => {
    const graphDir = join(LIB, 'graph')
    let checked = 0
    const offenders: string[] = []
    for (const file of sourceFiles(graphDir)) {
      checked++
      const src = readFileSync(file, 'utf8')
      // A parameter named upn/userPrincipalName/mailbox/userId would let a caller
      // redirect the request at another person's calendar.
      const bad = src.match(
        /(?:function|const)\s+\w+\s*(?:=\s*)?\([^)]*\b(upn|userPrincipalName|mailbox|userEmail|userId)\s*[:,)]/i,
      )
      if (bad) offenders.push(`${file.replace(ROOT + '/', '')}: ${bad[0].slice(0, 80)}`)
    }
    expect(checked, 'lib/graph must contain source files').toBeGreaterThan(0)
    expect(offenders, 'no Graph function may take a user parameter').toEqual([])
  })

  it('every Graph user path is built from the constant', () => {
    const graphDir = join(LIB, 'graph')
    const offenders: string[] = []
    for (const file of sourceFiles(graphDir)) {
      const src = readFileSync(file, 'utf8')
      // Find any /users/... path segment and require it to interpolate the constant.
      for (const m of src.matchAll(/['"`][^'"`]*\/users\/([^'"`]*)['"`]/g)) {
        const tail = m[1]
        const usesConstant =
          tail.includes('${GRAPH_USER_PRINCIPAL_NAME}') || tail.includes('${UPN}')
        if (!usesConstant) offenders.push(`${file.replace(ROOT + '/', '')}: ${m[0]}`)
      }
    }
    expect(offenders, 'every /users/ path must interpolate the UPN constant').toEqual([])
  })
})

describe('other pinned configuration', () => {
  it('fixes the timezone rather than reading it from the client', () => {
    expect(TIMEZONE).toBe('Europe/Amsterdam')
    // Lives in constants.ts so Client Components can read it without pulling in
    // `server-only`; config.ts re-exports it for the server graph.
    const src = readFileSync(join(LIB, 'constants.ts'), 'utf8')
    const line = src.split('\n').find((l) => l.includes('export const TIMEZONE'))
    expect(line, 'TIMEZONE must be declared in constants.ts').toBeDefined()
    expect(line).toContain("'Europe/Amsterdam'")
    expect(line).not.toMatch(/process\.env/)
  })

  it('keeps constants.ts free of server-only so it stays client-safe', () => {
    const src = readFileSync(join(LIB, 'constants.ts'), 'utf8')
    // Match an actual import, not the words in the comment explaining its absence.
    expect(src, 'constants.ts must be importable from a client bundle').not.toMatch(
      /^\s*import\s+['"]server-only['"]/m,
    )
    expect(src, 'constants must be compile-time literals').not.toMatch(/process\.env/)
  })

  it('scopes Linear to the single team', () => {
    expect(LINEAR_TEAM_KEY).toBe('RW')
  })
})
