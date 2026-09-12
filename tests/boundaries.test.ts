import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname, resolve } from 'node:path'

/**
 * Server/client boundary guards.
 *
 * A Client Component that imports a *runtime value* from a server-only module drags the
 * whole module — and every API client it touches — into the browser bundle. Next.js
 * catches it, but only at request time, as a 500 with a long module trace.
 *
 * This bit us twice while wiring the drill-in: `BLOCK_ORDER` and then
 * `BLOCK_SOURCE_LABELS`. Type-only imports are erased at build time and are always fine;
 * the rule is only about values. These tests fail fast instead.
 */

const ROOT = resolve(__dirname, '..')

function sourceFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return acc
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) acc.push(full)
  }
  return acc
}

const ALL = [...sourceFiles(join(ROOT, 'lib')), ...sourceFiles(join(ROOT, 'components')), ...sourceFiles(join(ROOT, 'app'))]

const isClient = (src: string) => /^\s*['"]use client['"]/.test(src)
const isServerOnly = (src: string) => /^\s*import\s+['"]server-only['"]/m.test(src)

/** Every non-type import specifier in `src`, as written. */
function valueImports(src: string): string[] {
  const out: string[] = []
  const re = /import\s+(?!type\s)([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g
  for (const m of src.matchAll(re)) {
    const clause = m[1]
    // `import { type A, type B } from 'x'` is entirely type-only in practice.
    const named = clause.match(/\{([\s\S]*)\}/)
    if (named) {
      const specifiers = named[1].split(',').map((s) => s.trim()).filter(Boolean)
      if (specifiers.length > 0 && specifiers.every((s) => s.startsWith('type '))) continue
    }
    out.push(m[2])
  }
  return out
}

function resolveLocal(fromFile: string, spec: string): string | null {
  let base: string | null = null
  if (spec.startsWith('@/')) base = join(ROOT, spec.slice(2))
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec)
  if (!base) return null
  for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    try {
      if (statSync(cand).isFile()) return cand
    } catch {
      /* keep looking */
    }
  }
  return null
}

/** Transitively collect server-only modules reachable through value imports. */
function taintedBy(file: string, seen = new Set<string>()): string[] {
  const src = readFileSync(file, 'utf8')
  if (isServerOnly(src)) return [file]
  const hits: string[] = []
  for (const spec of valueImports(src)) {
    const target = resolveLocal(file, spec)
    if (!target || seen.has(target)) continue
    seen.add(target)
    hits.push(...taintedBy(target, seen))
  }
  return hits
}

describe('server/client boundaries', () => {
  const clientFiles = ALL.filter((f) => isClient(readFileSync(f, 'utf8')))

  it('finds the Client Components to check', () => {
    expect(clientFiles.length, 'expected at least one "use client" module').toBeGreaterThan(0)
  })

  it('no Client Component pulls a server-only module into the browser bundle', () => {
    const offenders: string[] = []
    for (const file of clientFiles) {
      const tainted = taintedBy(file)
      if (tainted.length) {
        offenders.push(
          `${relative(ROOT, file)} → ${[...new Set(tainted)].map((t) => relative(ROOT, t)).join(', ')}`,
        )
      }
    }
    expect(
      offenders,
      'import these as `import type`, or move the runtime value to a client-safe module',
    ).toEqual([])
  })

  it('lib/constants.ts and lib/testids.ts stay client-safe', () => {
    for (const name of ['constants.ts', 'testids.ts']) {
      const src = readFileSync(join(ROOT, 'lib', name), 'utf8')
      expect(isServerOnly(src), `${name} must not be server-only`).toBe(false)
    }
  })

  it('marks the modules that talk to external services as server-only', () => {
    // These hold credentials. If one loses its marker, the guard above goes quiet.
    for (const rel of ['lib/config.ts', 'lib/view-model.ts', 'lib/scheduler.ts']) {
      const src = readFileSync(join(ROOT, rel), 'utf8')
      expect(isServerOnly(src), `${rel} must import 'server-only'`).toBe(true)
    }
  })
})
