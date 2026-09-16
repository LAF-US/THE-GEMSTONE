// Reads the values the site tests need from quartz.config.ts. The config
// cannot be imported by a test: it pulls in every Quartz component and their
// stylesheets, which only the esbuild pipeline can load. It is parsed instead
// with the TypeScript compiler the build already depends on, so comments,
// quoting and trailing commas are the parser's business and each value is
// read from the syntax tree as the literal it is. Every lookup fails loudly
// when what it expects is not there. This is a reader for the tests, not
// configuration of its own.
import assert from "node:assert"
import fs from "node:fs"
import ts from "typescript"

const config = ts.createSourceFile(
  "quartz.config.ts",
  fs.readFileSync("quartz.config.ts", "utf8"),
  ts.ScriptTarget.Latest,
  true,
)

// Every node of the config, in source order.
const nodes: ts.Node[] = []
const visit = (node: ts.Node) => {
  nodes.push(node)
  ts.forEachChild(node, visit)
}
visit(config)

// The one item in `matches`, or a failed assertion naming `what` so that a
// config edit which removes or duplicates it is noticed at once.
function only<T>(matches: T[], what: string): T {
  const count = matches.length
  assert.strictEqual(count, 1, `expected one ${what} in quartz.config.ts, found ${count}`)
  return matches[0]
}

// A scalar literal as the value it denotes, or undefined for any other node.
function scalarOf(node: ts.Node): string | number | boolean | null | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isNumericLiteral(node)) return Number(node.text)
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (node.kind === ts.SyntaxKind.NullKeyword) return null
  return undefined
}

// A literal expression as the value it denotes: a scalar, or an array or
// object of literals. Anything else is not a literal the tests can read.
function valueOf(node: ts.Node): unknown {
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(valueOf)
  if (ts.isObjectLiteralExpression(node)) return Object.fromEntries(node.properties.map(entryOf))
  const scalar = scalarOf(node)
  assert(scalar !== undefined, `${node.getText()} in quartz.config.ts is not a literal`)
  return scalar
}

// A property of an object literal as a [name, value] pair.
function entryOf(property: ts.ObjectLiteralElementLike): [string, unknown] {
  assert(ts.isPropertyAssignment(property), `${property.getText()} is not a plain property`)
  const name = property.name
  assert(ts.isIdentifier(name) || ts.isStringLiteral(name), `${name.getText()} is not a plain name`)
  return [name.text, valueOf(property.initializer)]
}

// The calls that configure a plugin, written `Plugin.Name(...)`.
function pluginCalls(plugin: string): ts.CallExpression[] {
  return nodes.filter(
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Plugin" &&
      node.expression.name.text === plugin,
  )
}

// Whether the config lists a plugin. Each emitter and filter the tests model
// contributes only when it is configured, so removing one turns the footer
// links it served into failures.
export function configured(plugin: string): boolean {
  return pluginCalls(plugin).length > 0
}

// The options a plugin is configured with, as literals: the object it merges
// over its own defaults, or none when it is called without one.
export function configuredOptions(plugin: string): Record<string, unknown> {
  const [options] = only(pluginCalls(plugin), `Plugin.${plugin}()`).arguments
  if (options === undefined) return {}
  assert(ts.isObjectLiteralExpression(options), `Plugin.${plugin}() is not given an object literal`)
  return Object.fromEntries(options.properties.map(entryOf))
}

// The value of the one property of the config with the given name.
function setting(name: string): unknown {
  const assignments = nodes.filter(
    (node): node is ts.PropertyAssignment =>
      ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === name,
  )
  return valueOf(only(assignments, name).initializer)
}

// The ignorePatterns array the build passes to its content glob.
export function configuredIgnorePatterns(): string[] {
  const patterns = setting("ignorePatterns")
  assert(Array.isArray(patterns), "ignorePatterns in quartz.config.ts is not an array")
  return patterns.map(String)
}

// Host and optional path prefix the site is served from, as Quartz's baseUrl.
export function configuredBase(): { host: string; prefix: string } {
  const [host, ...rest] = String(setting("baseUrl")).split("/")
  return { host, prefix: rest.join("/") }
}
