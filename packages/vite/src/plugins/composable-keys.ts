import { pathToFileURL } from 'node:url'
import { createUnplugin } from 'unplugin'
import { isAbsolute, relative } from 'pathe'
import type { Node } from 'estree-walker'
import { walk } from 'estree-walker'
import MagicString from 'magic-string'
import { hash } from 'ohash'
import type { CallExpression, Pattern } from 'estree'
import { parseQuery, parseURL } from 'ufo'
import escapeRE from 'escape-string-regexp'
import { findStaticImports, parseStaticImport } from 'mlly'
import { matchWithStringOrRegex } from '../utils'

interface ComposableKeysOptions {
  sourcemap: boolean
  rootDir: string
  composables: Array<{ name: string, source?: string | RegExp, argumentLength: number }>
}

const stringTypes: Array<string | undefined> = ['Literal', 'TemplateLiteral']
const NUXT_LIB_RE = /node_modules\/(?:nuxt|nuxt3|nuxt-nightly)\//
const SUPPORTED_EXT_RE = /\.(?:m?[jt]sx?|vue)/
const SCRIPT_RE = /(?<=<script[^>]*>)[\s\S]*?(?=<\/script>)/i

export const composableKeysPlugin = createUnplugin((options: ComposableKeysOptions) => {
  const composableMeta: Record<string, any> = {}
  const composableLengths = new Set<number>()
  const keyedFunctions = new Set<string>()
  for (const { name, ...meta } of options.composables) {
    composableMeta[name] = meta
    keyedFunctions.add(name)
    composableLengths.add(meta.argumentLength)
  }

  const maxLength = Math.max(...composableLengths)
  const KEYED_FUNCTIONS_RE = new RegExp(`\\b(${[...keyedFunctions].map(f => escapeRE(f)).join('|')})\\b`)

  return {
    name: 'nuxt:composable-keys',
    enforce: 'post',
    transformInclude (id) {
      const { pathname, search } = parseURL(decodeURIComponent(pathToFileURL(id).href))
      return !NUXT_LIB_RE.test(pathname) && SUPPORTED_EXT_RE.test(pathname) && parseQuery(search).type !== 'style' && !parseQuery(search).macro
    },
    transform (code, id) {
      if (!KEYED_FUNCTIONS_RE.test(code)) { return }
      const { 0: script = code, index: codeIndex = 0 } = code.match(SCRIPT_RE) || { index: 0, 0: code }
      const s = new MagicString(code)
      // https://github.com/unjs/unplugin/issues/90
      let imports: Set<string> | undefined
      let count = 0
      const relativeID = isAbsolute(id) ? relative(options.rootDir, id) : id
      const { pathname: relativePathname } = parseURL(relativeID)

      const ast = this.parse(script, {
        sourceType: 'module',
        ecmaVersion: 'latest',
      }) as Node

      // To handle variables hoisting we need a pre-pass to collect variable and function declarations with scope info.
      let scopeTracker = new ScopeTracker()
      const varCollector = new ScopedVarsCollector()
      walk(ast, {
        enter (_node) {
          if (_node.type === 'BlockStatement') {
            scopeTracker.enterScope()
            varCollector.refresh(scopeTracker.curScopeKey)
          } else if (_node.type === 'FunctionDeclaration' && _node.id) {
            varCollector.addVar(_node.id.name)
          } else if (_node.type === 'VariableDeclarator') {
            varCollector.collect(_node.id)
          }
        },
        leave (_node) {
          if (_node.type === 'BlockStatement') {
            scopeTracker.leaveScope()
            varCollector.refresh(scopeTracker.curScopeKey)
          }
        },
      })

      scopeTracker = new ScopeTracker()
      walk(ast, {
        enter (_node) {
          if (_node.type === 'BlockStatement') {
            scopeTracker.enterScope()
          }
          if (_node.type !== 'CallExpression' || (_node as CallExpression).callee.type !== 'Identifier') { return }
          const node: CallExpression = _node as CallExpression
          const name = 'name' in node.callee && node.callee.name
          if (!name || !keyedFunctions.has(name) || node.arguments.length >= maxLength) { return }

          imports = imports || detectImportNames(script, composableMeta)
          if (imports.has(name)) { return }

          const meta = composableMeta[name]

          if (varCollector.hasVar(scopeTracker.curScopeKey, name)) {
            let skip = true
            if (meta.source) {
              skip = !matchWithStringOrRegex(relativePathname, meta.source)
            }

            if (skip) { return }
          }

          if (node.arguments.length >= meta.argumentLength) { return }

          switch (name) {
            case 'useState':
              if (stringTypes.includes(node.arguments[0]?.type)) { return }
              break

            case 'useFetch':
            case 'useLazyFetch':
              if (stringTypes.includes(node.arguments[1]?.type)) { return }
              break

            case 'useAsyncData':
            case 'useLazyAsyncData':
              if (stringTypes.includes(node.arguments[0]?.type) || stringTypes.includes(node.arguments[node.arguments.length - 1]?.type)) { return }
              break
          }

          // TODO: Optimize me (https://github.com/nuxt/framework/pull/8529)
          const newCode = code.slice(codeIndex + (node as any).start, codeIndex + (node as any).end - 1).trim()
          const endsWithComma = newCode[newCode.length - 1] === ','

          s.appendLeft(
            codeIndex + (node as any).end - 1,
            (node.arguments.length && !endsWithComma ? ', ' : '') + '\'$' + hash(`${relativeID}-${++count}`) + '\'',
          )
        },
        leave (_node) {
          if (_node.type === 'BlockStatement') {
            scopeTracker.leaveScope()
          }
        },
      })
      if (s.hasChanged()) {
        return {
          code: s.toString(),
          map: options.sourcemap
            ? s.generateMap({ hires: true })
            : undefined,
        }
      }
    },
  }
})

/*
* track scopes with unique keys. for example
* ```js
* // root scope, marked as ''
* function a () { // '0'
*   function b () {} // '0-0'
*   function c () {} // '0-1'
* }
* function d () {} // '1'
* // ''
* ```
* */
class ScopeTracker {
  // the top of the stack is not a part of current key, it is used for next level
  scopeIndexStack: number[]
  curScopeKey: string

  constructor () {
    this.scopeIndexStack = [0]
    this.curScopeKey = ''
  }

  getKey () {
    return this.scopeIndexStack.slice(0, -1).join('-')
  }

  enterScope () {
    this.scopeIndexStack.push(0)
    this.curScopeKey = this.getKey()
  }

  leaveScope () {
    this.scopeIndexStack.pop()
    this.curScopeKey = this.getKey()
    this.scopeIndexStack[this.scopeIndexStack.length - 1]!++
  }
}

class ScopedVarsCollector {
  curScopeKey: string
  all: Map<string, Set<string>>

  constructor () {
    this.all = new Map()
    this.curScopeKey = ''
  }

  refresh (scopeKey: string) {
    this.curScopeKey = scopeKey
  }

  addVar (name: string) {
    let vars = this.all.get(this.curScopeKey)
    if (!vars) {
      vars = new Set()
      this.all.set(this.curScopeKey, vars)
    }
    vars.add(name)
  }

  hasVar (scopeKey: string, name: string) {
    const indices = scopeKey.split('-').map(Number)
    for (let i = indices.length; i >= 0; i--) {
      if (this.all.get(indices.slice(0, i).join('-'))?.has(name)) {
        return true
      }
    }
    return false
  }

  collect (n: Pattern) {
    const t = n.type
    if (t === 'Identifier') {
      this.addVar(n.name)
    } else if (t === 'RestElement') {
      this.collect(n.argument)
    } else if (t === 'AssignmentPattern') {
      this.collect(n.left)
    } else if (t === 'ArrayPattern') {
      n.elements.forEach(e => e && this.collect(e))
    } else if (t === 'ObjectPattern') {
      n.properties.forEach((p) => {
        if (p.type === 'RestElement') {
          this.collect(p)
        } else {
          this.collect(p.value)
        }
      })
    }
  }
}

const NUXT_IMPORT_RE = /nuxt|#app|#imports/

export function detectImportNames (code: string, composableMeta: Record<string, { source?: string | RegExp }>) {
  const names = new Set<string>()
  function addName (name: string, specifier: string) {
    const source = composableMeta[name]?.source
    if (source && matchWithStringOrRegex(specifier, source)) {
      return
    }
    names.add(name)
  }

  for (const i of findStaticImports(code)) {
    if (NUXT_IMPORT_RE.test(i.specifier)) { continue }

    const { namedImports = {}, defaultImport, namespacedImport } = parseStaticImport(i)
    for (const name in namedImports) {
      addName(namedImports[name]!, i.specifier)
    }
    if (defaultImport) {
      addName(defaultImport, i.specifier)
    }
    if (namespacedImport) {
      addName(namespacedImport, i.specifier)
    }
  }
  return names
}
