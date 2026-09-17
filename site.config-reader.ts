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

// An element of a plugins array as the call `Plugin.Name(...)` it must be.
// The tests count a plugin only while it is written there as a call, so a
// spread, a condition or a variable is refused rather than guessed at.
function pluginCall(element: ts.Node): ts.CallExpression {
  assert(
    ts.isCallExpression(element) &&
      ts.isPropertyAccessExpression(element.expression) &&
      ts.isIdentifier(element.expression.expression) &&
      element.expression.expression.text === "Plugin",
    `${element.getText()} in quartz.config.ts is not a plugin written as Plugin.Name(...)`,
  )
  return element
}

// The name of a plugin call: `Name` in `Plugin.Name(...)`.
function pluginName(call: ts.CallExpression): string {
  return (call.expression as ts.PropertyAccessExpression).name.text
}

// A property of the plugins object as its name and the array it holds.
function groupOf(group: ts.ObjectLiteralElementLike): [string, ts.ArrayLiteralExpression] {
  assert(
    ts.isPropertyAssignment(group) && ts.isIdentifier(group.name),
    `${group.getText()} is not a plain property`,
  )
  const array = group.initializer
  assert(ts.isArrayLiteralExpression(array), `${group.getText()} is not an array of plugins`)
  return [group.name.text, array]
}

// A reader for one config source. The site's own config is read below; the
// tests of the reader itself pass small configs written in place.
export function configReader(source: string) {
  const file = ts.createSourceFile("quartz.config.ts", source, ts.ScriptTarget.Latest, true)
  const nodes: ts.Node[] = []
  const visit = (node: ts.Node) => {
    nodes.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)

  // The value of the one property of the config with the given name.
  const property = (name: string): ts.Expression =>
    only(
      nodes.filter(
        (node): node is ts.PropertyAssignment =>
          ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === name,
      ),
      name,
    ).initializer

  // The calls that configure plugins: the elements of the transformers,
  // filters and emitters arrays of the config's plugins object, the three
  // Quartz runs. Any other key there is refused rather than counted.
  const plugins = property("plugins")
  assert(ts.isObjectLiteralExpression(plugins), "plugins in quartz.config.ts is not an object")
  const calls = plugins.properties.flatMap((group) => {
    const [name, array] = groupOf(group)
    assert(
      ["transformers", "filters", "emitters"].includes(name),
      `plugins.${name} is not a plugin array Quartz runs`,
    )
    return array.elements.map(pluginCall)
  })
  const named = (plugin: string) => calls.filter((call) => pluginName(call) === plugin)

  return {
    // Whether the config lists a plugin. Each emitter and filter the tests
    // model contributes only when it is configured, so removing one turns the
    // footer links it served into failures.
    configured: (plugin: string): boolean => named(plugin).length > 0,

    // Whether the config lists one plugin before another. Quartz attaches the
    // transformers' markdown plugins in the order the config lists them, so
    // what one leaves for the next depends on that order.
    configuredBefore: (plugin: string, other: string): boolean =>
      calls.indexOf(only(named(plugin), `Plugin.${plugin}()`)) <
      calls.indexOf(only(named(other), `Plugin.${other}()`)),

    // The options a plugin is configured with, as literals: the object it
    // merges over its own defaults, or none when it is called without one.
    configuredOptions: (plugin: string): Record<string, unknown> => {
      const [options] = only(named(plugin), `Plugin.${plugin}()`).arguments
      if (options === undefined) return {}
      assert(ts.isObjectLiteralExpression(options), `Plugin.${plugin}() is not given an object`)
      return Object.fromEntries(options.properties.map(entryOf))
    },

    // The ignorePatterns array the build passes to its content glob.
    configuredIgnorePatterns: (): string[] => {
      const patterns = valueOf(property("ignorePatterns"))
      assert(Array.isArray(patterns), "ignorePatterns in quartz.config.ts is not an array")
      return patterns.map(String)
    },

    // Host and optional path prefix the site is served from, as Quartz's
    // baseUrl.
    configuredBase: (): { host: string; prefix: string } => {
      const [host, ...rest] = String(valueOf(property("baseUrl"))).split("/")
      return { host, prefix: rest.join("/") }
    },
  }
}

// The reader of the site's own config, which the site tests use.
const reader = configReader(fs.readFileSync("quartz.config.ts", "utf8"))
export const {
  configured,
  configuredBefore,
  configuredOptions,
  configuredIgnorePatterns,
  configuredBase,
} = reader
