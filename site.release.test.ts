// Tests for The Gemstone's release boundaries: what leaves the repository in
// a Docker build context, an npm package or a pre-commit.ci run. Run with
// `npm test`, which runs from the repository root, so every path below is a
// literal relative to it. site.footer.test.ts covers the footer links.
import test, { describe } from "node:test"
import assert from "node:assert"
import fs from "node:fs"
import path from "node:path"

// Non-empty, non-comment lines of a small config file, trimmed.
function configLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
}

// One .dockerignore pattern as Docker matches it, ported from Pattern.compile
// and Pattern.match in moby/patternmatcher: a pattern without wildcards must
// equal the path; `**` at the end matches any path with the rest as a prefix;
// `**` at the start matches any path with the rest as a suffix; otherwise `**`
// spans directories, `*` and `?` stay within one, `[...]` is a character class
// and `\` escapes the next character.
function dockerMatcher(pattern: string): (candidate: string) => boolean {
  let source = "^"
  let kind: "exact" | "prefix" | "suffix" | "regexp" = "exact"
  for (let at = 0, first = true; at < pattern.length; first = false) {
    const ch = pattern[at++]
    if (ch === "*" && pattern[at] === "*") {
      at++
      if (pattern[at] === "/") at++
      if (at >= pattern.length) {
        if (kind === "exact") kind = "prefix"
        else {
          source += ".*"
          kind = "regexp"
        }
      } else {
        source += "(.*/)?"
        kind = "regexp"
      }
      if (first) kind = "suffix"
    } else if (ch === "*") {
      source += "[^/]*"
      kind = "regexp"
    } else if (ch === "?") {
      source += "[^/]"
      kind = "regexp"
    } else if (ch === "\\" && at < pattern.length) {
      source += `\\${pattern[at++]}`
      kind = "regexp"
    } else if (ch === "[" || ch === "]") {
      source += ch
      kind = "regexp"
    } else {
      // Docker escapes exactly these before compiling the regex; `^` is not
      // among them, which is what lets `[^...]` negate a character class.
      source += ch.replace(/[.+()|{}$\\]/, "\\$&")
    }
  }
  switch (kind) {
    case "exact":
      return (candidate) => candidate === pattern
    case "prefix":
      return (candidate) => candidate.startsWith(pattern.slice(0, -2))
    case "suffix": {
      const suffix = pattern.slice(2)
      return (candidate) =>
        candidate.endsWith(suffix) || (suffix.startsWith("/") && candidate === suffix.slice(1))
    }
    default: {
      const regex = new RegExp(`${source}$`)
      return (candidate) => regex.test(candidate)
    }
  }
}

// Whether Docker leaves a file out of the build context under a .dockerignore,
// ported from ReadAll in moby/patternmatcher/ignorefile and
// MatchesOrParentMatches in moby/patternmatcher: a line starting with # is a
// comment; each pattern is trimmed, cleaned (so `.git/` and `./.git` mean
// `.git`) and stripped of one leading slash, and a leading `!` negates it;
// patterns apply in order, a pattern matches the file or any of its parent
// directories, and the last one to match decides.
function dockerIgnores(dockerignore: string, file: string): boolean {
  const rules = dockerignore.split("\n").flatMap((line) => {
    if (line.startsWith("#")) return []
    let pattern = line.replace(/\r$/, "").trim()
    if (pattern === "") return []
    const negated = pattern.startsWith("!")
    if (negated) pattern = pattern.slice(1).trim()
    if (pattern !== "") {
      pattern = path.posix.normalize(pattern).replace(/(?<=.)\/$/, "")
      if (pattern.length > 1 && pattern.startsWith("/")) pattern = pattern.slice(1)
    }
    return [{ negated, matches: dockerMatcher(pattern) }]
  })
  const segments = file.split("/")
  const candidates = segments.map((_, depth) => segments.slice(0, depth + 1).join("/"))
  let matched = false
  for (const rule of rules) {
    if (rule.negated !== matched) continue
    if (candidates.some(rule.matches)) matched = !rule.negated
  }
  return matched
}

describe("release boundaries", () => {
  test(".dockerignore keeps git history for page dates and drops local state", () => {
    const dockerignore = fs.readFileSync(".dockerignore", "utf8")
    assert(
      !dockerIgnores(dockerignore, ".git/HEAD"),
      "CreatedModifiedDate reads page dates from git; .git must stay in the Docker context",
    )
    for (const file of [".npmrc", "node_modules/preact/package.json", "public/index.html"]) {
      assert(dockerIgnores(dockerignore, file), `.dockerignore should exclude ${file}`)
    }
  })

  test(".npmignore ignores everything and package.json is private", () => {
    assert.deepStrictEqual(configLines(fs.readFileSync(".npmignore", "utf8")), ["*"])
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"))
    assert.strictEqual(
      pkg.private,
      true,
      "package.json must stay private; that is what stops npm publish",
    )
  })

  test("pre-commit.ci runs read-only hooks and never rewrites a branch", () => {
    // The file is prettier-formatted, so its settings are one per line and can
    // be checked as text; no YAML deserializer is needed in test code.
    const lines = configLines(fs.readFileSync(".pre-commit-config.yaml", "utf8"))
    assert(lines.includes("autofix_prs: false"), "pre-commit.ci must not push fixes to branches")
    const readOnly = new Set([
      "check-merge-conflict",
      "check-symlinks",
      "check-yaml",
      "detect-private-key",
    ])
    const hookIds = lines.flatMap((line) => {
      const match = /^- id: (\S+)$/.exec(line)
      return match ? [match[1]] : []
    })
    assert(hookIds.length > 0, "no hooks found in .pre-commit-config.yaml")
    for (const id of hookIds) {
      assert(readOnly.has(id), `hook ${id} is not in the read-only set`)
    }
  })
})
