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

// How Docker ends up matching a .dockerignore pattern, as Pattern.compile in
// moby/patternmatcher detects it while turning the pattern into a regex: a
// pattern without wildcards is compared for equality, one ending in `**` as a
// prefix, one starting with `**` as a suffix, and any other by the regex.
type DockerMatchKind = "exact" | "prefix" | "suffix" | "regexp"

// One token of a pattern, read at `at`: how many characters it takes, the
// regex it contributes, and the match kind the pattern has after it.
type DockerToken = { length: number; source: string; kind: DockerMatchKind }

// A `**` read at `at`: a following slash is eaten with it; at the end of the
// pattern it makes a wildcard-free pattern a prefix match and otherwise adds
// `.*`; elsewhere it spans any number of directories.
function dockerDoubleStar(pattern: string, at: number, kind: DockerMatchKind): DockerToken {
  const length = pattern[at + 2] === "/" ? 3 : 2
  if (at + length < pattern.length) return { length, source: "(.*/)?", kind: "regexp" }
  if (kind === "exact") return { length, source: "", kind: "prefix" }
  return { length, source: ".*", kind: "regexp" }
}

// The token at `at`: `*` and `?` stay within one directory, `[` and `]` pass
// through as a character class, `\` escapes the next character, and any other
// character is literal. Docker escapes exactly `.+()|{}$` before compiling
// the regex; `^` is not among them, which is what lets `[^...]` negate a class.
function dockerToken(pattern: string, at: number, kind: DockerMatchKind): DockerToken {
  const ch = pattern[at]
  if (pattern.startsWith("**", at)) return dockerDoubleStar(pattern, at, kind)
  if (ch === "*") return { length: 1, source: "[^/]*", kind: "regexp" }
  if (ch === "?") return { length: 1, source: "[^/]", kind: "regexp" }
  if (ch === "\\" && at + 1 < pattern.length) {
    return { length: 2, source: `\\${pattern[at + 1]}`, kind: "regexp" }
  }
  if ("[]".includes(ch)) return { length: 1, source: ch, kind: "regexp" }
  return { length: 1, source: ch.replace(/[.+()|{}$\\]/, "\\$&"), kind }
}

// The test Pattern.match applies for a compiled pattern of the given kind.
function dockerMatch(
  pattern: string,
  kind: DockerMatchKind,
  source: string,
): (candidate: string) => boolean {
  if (kind === "exact") return (candidate) => candidate === pattern
  if (kind === "prefix") return (candidate) => candidate.startsWith(pattern.slice(0, -2))
  if (kind === "suffix") {
    const suffix = pattern.slice(2)
    return (candidate) =>
      candidate.endsWith(suffix) || (suffix.startsWith("/") && candidate === suffix.slice(1))
  }
  const regex = new RegExp(`${source}$`)
  return (candidate) => regex.test(candidate)
}

// One .dockerignore pattern as Docker matches it, ported from Pattern.compile
// and Pattern.match in moby/patternmatcher: the pattern is read token by
// token into a regex while the match kind is tracked, with a leading `**`
// always making a suffix match, and the kind decides the test applied.
function dockerMatcher(pattern: string): (candidate: string) => boolean {
  let source = "^"
  let kind: DockerMatchKind = "exact"
  for (let at = 0; at < pattern.length; ) {
    const token = dockerToken(pattern, at, kind)
    source += token.source
    kind = at === 0 && pattern.startsWith("**") ? "suffix" : token.kind
    at += token.length
  }
  return dockerMatch(pattern, kind, source)
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
    // CreatedModifiedDate opens the repository with @napi-rs/simple-git and
    // walks the commit history for each note, which needs the whole layout git
    // documents in gitrepository-layout(5), not HEAD alone: the config, the
    // refs and packed refs, loose and packed objects, and the shallow file a
    // CI checkout leaves. A partial exclusion such as `.git/objects`, or
    // `.git/*` with `!.git/HEAD`, would find a repository it cannot read.
    for (const file of [
      ".git/HEAD",
      ".git/config",
      ".git/packed-refs",
      ".git/shallow",
      ".git/refs/heads/main",
      ".git/refs/tags/v4.5.2",
      ".git/objects/pack/pack-0.pack",
      ".git/objects/pack/pack-0.idx",
      ".git/objects/ab/cdef",
    ]) {
      assert(
        !dockerIgnores(dockerignore, file),
        `CreatedModifiedDate reads page dates from git; ${file} must stay in the Docker context`,
      )
    }
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
