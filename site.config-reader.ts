// Reads the literals the site tests need from quartz.config.ts. The config
// cannot be imported by a test: it pulls in every Quartz component and their
// stylesheets, which only the esbuild pipeline can load. The values the tests
// need are short literals, so they are read from the source text with its
// comments removed, and each lookup fails loudly if the literal it expects is
// not found. This is a reader for the tests, not configuration of its own.
import assert from "node:assert"
import fs from "node:fs"

// The index just past a comment that starts at `at`, or `at` when none does:
// a line comment runs to the end of its line, a block comment to its `*/`.
function commentEnd(source: string, at: number): number {
  if (source.startsWith("//", at)) {
    const end = source.indexOf("\n", at)
    return end === -1 ? source.length : end
  }
  if (source.startsWith("/*", at)) {
    const end = source.indexOf("*/", at + 2)
    return end === -1 ? source.length : end + 2
  }
  return at
}

// The three quote characters that open a string in the config.
const quotes = ['"', "'", "`"]

// The source with its comments removed, whether they fill a line or follow
// code on it, so that a plugin or option commented out is not read as
// configured. Quotes are honoured, so a `//` inside a string survives; regex
// literals are not tokenised, and the config has none.
function withoutComments(source: string): string {
  let out = ""
  let quote = ""
  for (let at = 0; at < source.length; ) {
    const ch = source[at]
    if (quote === "") {
      const end = commentEnd(source, at)
      if (end > at) {
        at = end
        continue
      }
      if (quotes.includes(ch)) quote = ch
      out += ch
      at += 1
      continue
    }
    // Inside a string: an escaped character never closes it.
    const step = ch === "\\" ? 2 : 1
    out += source.slice(at, at + step)
    if (step === 1 && ch === quote) quote = ""
    at += step
  }
  return out
}

export const quartzConfig = withoutComments(fs.readFileSync("quartz.config.ts", "utf8"))

// The first capture of `pattern` in quartz.config.ts, or a failed assertion
// naming `what` so a config edit that moves the literal is noticed at once.
function configLiteral(pattern: RegExp, what: string): string {
  const match = pattern.exec(quartzConfig)
  assert(match, `could not find ${what} in quartz.config.ts`)
  return match[1]
}

// Whether the config lists a plugin, written as `Plugin.Name(`. Each emitter
// and filter the tests model contributes only when it is configured, so
// removing one turns the footer links it served into failures.
export function configured(plugin: string): boolean {
  return quartzConfig.includes(`Plugin.${plugin}(`)
}

// The ignorePatterns array the build passes to its content glob.
export function configuredIgnorePatterns(): string[] {
  const literal = configLiteral(/ignorePatterns:\s*(\[[^\]]*\])/, "ignorePatterns")
  return JSON.parse(literal.replaceAll("'", '"').replace(/,\s*\]/, "]"))
}

// Host and optional path prefix the site is served from, as Quartz's baseUrl.
// The quotes in the pattern are written \x22: Lizard, which Codacy runs on
// this file, reads a bare quote inside a regex literal as the start of a
// string and misreads every function after it.
export function configuredBase(): { host: string; prefix: string } {
  const [host, ...rest] = configLiteral(/baseUrl:\s*\x22([^\x22]+)\x22/, "baseUrl").split("/")
  return { host, prefix: rest.join("/") }
}
