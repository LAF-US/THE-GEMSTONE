// Tests for The Gemstone's release boundaries: what leaves the repository in
// a Docker build context or an npm package. Run with `npm test`, which runs
// from the repository root, so every path below is a literal relative to it.
// site.precommit.test.ts covers pre-commit.ci and site.footer.test.ts the
// footer links.
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

// The index past one end of a range in a character class at `at`, or -1
// where getEsc in Go's filepath.Match fails: nothing there, a `-` or `]`
// there, a backslash with nothing to escape, or nothing after the character.
function dockerEscEnd(pattern: string, at: number): number {
  if (at >= pattern.length || "-]".includes(pattern[at])) return -1
  if (pattern[at] === "\\") at += 1
  if (at + 1 >= pattern.length) return -1
  return at + 1
}

// The index past one range of a character class at `at`: its low end, and
// its high end after a `-`; or -1 when either is malformed.
function dockerRangeEnd(pattern: string, at: number): number {
  const lo = dockerEscEnd(pattern, at)
  if (lo === -1 || pattern[lo] !== "-") return lo
  return dockerEscEnd(pattern, lo + 1)
}

// The index past a character class whose `[` sits before `at`, or -1 when
// filepath.Match calls it malformed: it may open with `^`, and must hold at
// least one range before its `]`.
function dockerClassEnd(pattern: string, at: number): number {
  if (pattern[at] === "^") at += 1
  for (let ranges = 0; at !== -1; ranges += 1) {
    if (pattern[at] === "]" && ranges > 0) return at + 1
    at = dockerRangeEnd(pattern, at)
  }
  return -1
}

// Whether filepath.Match, which patternmatcher.New runs on every pattern,
// calls it malformed: a backslash must escape a character, and a character
// class must be well formed.
function dockerMalformed(pattern: string): boolean {
  let at = 0
  while (at >= 0 && at < pattern.length) {
    if (pattern[at] === "\\") at += 2
    else if (pattern[at] === "[") at = dockerClassEnd(pattern, at + 1)
    else at += 1
  }
  return at !== pattern.length
}

// Why New in moby/patternmatcher would refuse a rule, or nothing: an
// exclusion with nothing left to exclude, or a malformed pattern.
function dockerRejection(negated: boolean, pattern: string): string | undefined {
  if (negated && (pattern === "" || pattern === "/")) return 'illegal exclusion pattern: "!"'
  if (dockerMalformed(pattern)) return "syntax error in pattern"
  return undefined
}

// A rule of a .dockerignore, negated or not, that tells whether a path
// matches it.
type DockerRule = { negated: boolean; matches: (candidate: string) => boolean }

// One line of a .dockerignore as a rule, or nothing for a comment or blank
// line, ported from ReadAll in moby/patternmatcher/ignorefile: the pattern
// is trimmed, cleaned (so `.git/` and `./.git` mean `.git`) and stripped of
// one leading slash, and a leading `!` negates it. A rule New would refuse
// is an error here, since Docker then refuses the whole file.
function dockerRule(line: string): DockerRule | undefined {
  if (line.startsWith("#")) return undefined
  let pattern = line.replace(/\r$/, "").trim()
  if (pattern === "") return undefined
  const negated = pattern.startsWith("!")
  if (negated) pattern = pattern.slice(1).trim()
  if (pattern !== "") {
    pattern = path.posix.normalize(pattern).replace(/(?<=.)\/$/, "")
    if (pattern.length > 1 && pattern.startsWith("/")) pattern = pattern.slice(1)
  }
  const rejection = dockerRejection(negated, pattern)
  if (rejection !== undefined) throw new Error(`${rejection}: ${JSON.stringify(line)}`)
  return { negated, matches: dockerMatcher(pattern) }
}

// Whether Docker leaves a file out of the build context under a
// .dockerignore, as MatchesOrParentMatches in moby/patternmatcher decides:
// rules apply in order, a rule matches the file or any of its parent
// directories, and the last one to match decides.
function dockerIgnores(dockerignore: string, file: string): boolean {
  const rules = dockerignore.split("\n").flatMap((line) => dockerRule(line) ?? [])
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
    // `.git/*` with `!.git/HEAD`, would find a repository it cannot read. The
    // object names have the length git writes, a two-character directory and
    // thirty-eight more hex characters for a loose object and a forty-character
    // hash for a pack, since `?` matches exactly one character and a rule
    // spelled that way would exclude every real object while sparing a
    // shorter probe.
    const hash = "6a677ccb6c36cde40c82b43245028bf04cc2f847"
    for (const file of [
      ".git/HEAD",
      ".git/config",
      ".git/packed-refs",
      ".git/shallow",
      ".git/refs/heads/main",
      ".git/refs/tags/v4.5.2",
      `.git/objects/pack/pack-${hash}.pack`,
      `.git/objects/pack/pack-${hash}.idx`,
      `.git/objects/pack/pack-${hash}.rev`,
      `.git/objects/${hash.slice(0, 2)}/${hash.slice(2)}`,
    ]) {
      assert(
        !dockerIgnores(dockerignore, file),
        `CreatedModifiedDate reads page dates from git; ${file} must stay in the Docker context`,
      )
    }
    for (const file of [
      ".npmrc",
      ".env",
      ".env.local",
      "node_modules/preact/package.json",
      "public/index.html",
    ]) {
      assert(dockerIgnores(dockerignore, file), `.dockerignore should exclude ${file}`)
    }
  })

  test("the .dockerignore port refuses the patterns Docker refuses", () => {
    // Checked against moby's own matcher through Go: New refuses an
    // exclusion with nothing to exclude, an unescaped trailing backslash and
    // a character class filepath.Match calls malformed, and a range out of
    // order fails when the pattern is compiled.
    const refused = [
      "!",
      "! ",
      "!/",
      "\\",
      "a\\",
      "[abc",
      "[]a]",
      "[a-]",
      "[^]",
      "[^]a]",
      "**/[",
      "a[",
      "[z-a]",
    ]
    for (const pattern of refused) {
      assert.throws(() => dockerIgnores(pattern, "a"), `Docker refuses ${JSON.stringify(pattern)}`)
    }
    // A `!` inside a class and an escaped `]` are ordinary characters.
    assert(dockerIgnores("[!a]", "a"))
    assert(!dockerIgnores("[\\]]", "a"))
    assert(dockerIgnores("[\\]]", "]"))
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
})
