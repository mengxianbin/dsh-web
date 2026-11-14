import test from 'node:test'
import assert from 'node:assert/strict'
import { checkRuntimeImports, importSpecifiers } from './runtime-deps-check.mjs'

test('flags a runtime import of a devDependencies-only package (issue #70)', () => {
  const violations = checkRuntimeImports(
    { dependencies: {}, devDependencies: { schemastery: '^3.18.0' } },
    { 'packages/skins/skin-center/lib/index.js': "import z from 'schemastery'" },
  )
  assert.equal(violations.length, 1)
  assert.equal(violations[0].specifier, 'schemastery')
})

test('accepts specifiers declared in dependencies', () => {
  const violations = checkRuntimeImports(
    { dependencies: { schemastery: '^3.18.0' } },
    { 'lib/index.js': "import z from 'schemastery'" },
  )
  assert.equal(violations.length, 0)
})

test('accepts runtime-provided @deepseek-ai/* specifiers', () => {
  const violations = checkRuntimeImports(
    { dependencies: {} },
    { 'lib/index.js': "import { Context } from '@deepseek-ai/cordis'" },
  )
  assert.equal(violations.length, 0)
})

test('accepts node: builtins and relative imports', () => {
  const violations = checkRuntimeImports(
    { dependencies: {} },
    { 'lib/index.js': "import { join } from 'node:path'\nimport x from './local.js'" },
  )
  assert.equal(violations.length, 0)
})

test('accepts package subpath imports when the parent package is a dependency', () => {
  const violations = checkRuntimeImports(
    { dependencies: { ssh2: '^1.17.0' } },
    { 'lib/index.js': "import { Client } from 'ssh2/lib/client'" },
  )
  assert.equal(violations.length, 0)
})

test('flags dynamic import() of a devDependencies-only package', () => {
  const violations = checkRuntimeImports(
    { dependencies: {} },
    { 'lib/index.js': "await import('some-optional-runtime-dep')" },
  )
  assert.equal(violations.length, 1)
  assert.equal(violations[0].specifier, 'some-optional-runtime-dep')
})

test('ignores prose that looks like an import inside comments', () => {
  const source = '/**\n * mtime; a root that appears later flips from \'missing\' to an mtime);\n */\nexport const x = 1\n'
  const violations = checkRuntimeImports({ dependencies: {} }, { 'lib/index.js': source })
  assert.equal(violations.length, 0)
})

test('ignores prose that looks like an import inside string and template literals', () => {
  const source = "export const a = \"flips from 'missing' to an mtime\"\nexport const b = `flips from 'missing' to an mtime`\nexport const c = 'flips from \"missing\" to an mtime'\n"
  const violations = checkRuntimeImports({ dependencies: {} }, { 'lib/index.js': source })
  assert.equal(violations.length, 0)
})

test('ignores property lookups named from or import', () => {
  const source = "const a = x.from('pkg-from')\nconst b = y.import('pkg-import')\n"
  const violations = checkRuntimeImports({ dependencies: {} }, { 'lib/index.js': source })
  assert.equal(violations.length, 0)
})

test('keeps flagging real imports next to comment prose', () => {
  const source = "// flips from 'missing' to an mtime\nimport { join } from 'node:path'\nimport x from 'missing-dep'\n"
  const violations = checkRuntimeImports({ dependencies: {} }, { 'lib/index.js': source })
  assert.equal(violations.length, 1)
  assert.equal(violations[0].specifier, 'missing-dep')
})

test('detects side effects and both re-export forms', () => {
  // Given a module form supported by the shipped bundles, when scanned, then expose only known specifiers.
  assert.deepEqual(importSpecifiers("import 'side'; export { value } from 'named'; export * from 'all';"), ["side","named","all"])
})

test('detects commented and no-substitution template dynamic imports', () => {
  // Given a module form supported by the shipped bundles, when scanned, then expose only known specifiers.
  assert.deepEqual(importSpecifiers("import /* comment */ ('dynamic'); import(`template`);"), ["dynamic","template"])
})

test('detects imports inside template expressions', () => {
  // Given a module form supported by the shipped bundles, when scanned, then expose only known specifiers.
  assert.deepEqual(importSpecifiers("const value = `before ${import('nested')} after`;"), ["nested"])
})

test('ignores computed imports and import meta', () => {
  // Given a module form supported by the shipped bundles, when scanned, then expose only known specifiers.
  assert.deepEqual(importSpecifiers("import(name); import(`prefix-${name}`); const url = import.meta.url;"), [])
})

test('decodes specifiers before dependency classification', () => {
  // Given a module form supported by the shipped bundles, when scanned, then expose only known specifiers.
  assert.deepEqual(importSpecifiers("import a from 'pkg\\u002Fsub'; import b from '\\u002e\\u002Flocal.js';"), ["pkg/sub","./local.js"])
})

test('ignores regex decoys without losing the following import', () => {
  // Given a module form supported by the shipped bundles, when scanned, then expose only known specifiers.
  assert.deepEqual(importSpecifiers("const a = /from 'decoy'/; const b = /'/; import real from 'real';"), ["real"])
})

test('reads static and dynamic imports with attributes', () => {
  // Given a module form supported by the shipped bundles, when scanned, then expose only known specifiers.
  assert.deepEqual(importSpecifiers("import data from 'static-json' with { type: 'json' }; import('dynamic-json', { with: { type: 'json' } });"), ["static-json","dynamic-json"])
})
test('reports lexer-detectable malformed imports with their artifact path', () => {
  // Given a truncated static import, when checked, then retain its owning filename in the error.
  assert.throws(() => checkRuntimeImports({}, { 'lib/broken.js': "import { value from 'pkg'" }), /Parse error lib\/broken\.js:/)
})

test('applies builtin and relative exemptions after escape decoding', () => {
  const source = "import a from '\\u002e\\u002Flocal.js'; import b from 'node\\u003apath';";
  assert.deepEqual(checkRuntimeImports({ dependencies: {} }, { 'lib/index.js': source }), [])
})

test('rejects undeclared side-effect dependencies even when they are development dependencies', () => {
  const violations = checkRuntimeImports({ devDependencies: { 'side-only': '*' } }, { 'lib/index.js': "import 'side-only';" })
  assert.deepEqual(violations, [{ file: 'lib/index.js', specifier: 'side-only' }])
})
