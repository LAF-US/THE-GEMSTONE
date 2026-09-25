// What a .dockerignore leaves in a Docker build context, for the release
// tests in site.release.test.ts: a port of the pattern matching in
// moby/patternmatcher and of how the two builders walk the context with it,
// the legacy builder through moby/go-archive and BuildKit through
// tonistiigi/fsutil. Checked against those packages through Go.
import path from "node:path"

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

// A rule of a .dockerignore, negated or not: its pattern as Docker cleans
// it, and whether a path matches it.
type DockerRule = { negated: boolean; pattern: string; matches: (candidate: string) => boolean }

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
  return { negated, pattern, matches: dockerMatcher(pattern) }
}

// A walker's result for one path: whether it is excluded, and which rules
// it or a directory above it matched, which the paths under it inherit.
type DockerExclusion = { excluded: boolean; matched: boolean[] }

// MatchesUsingParentResults in moby/patternmatcher, which both context
// walkers call for each path with the result for its directory: a rule that
// directory matched still applies; any other rule is tried in order, a plain
// rule only while the path is included so far and a negated one only while
// it is excluded; and the last rule to apply decides.
function dockerExclusion(
  rules: DockerRule[],
  candidate: string,
  parent?: DockerExclusion,
): DockerExclusion {
  let excluded = false
  const matched = rules.map((rule, index) => {
    const inherited = parent?.matched[index] ?? false
    const match = inherited || (rule.negated === excluded && rule.matches(candidate))
    if (match) excluded = !rule.negated
    return match
  })
  return { excluded, matched }
}

// A Docker builder's context walker, by whether it descends into an excluded
// directory for the files a negated rule spares, or prunes it.
type DockerWalker = { name: string; descends: (directory: string) => boolean }

// Docker's two context walkers. The legacy builder's, TarWithOptions in
// moby/go-archive, descends only when a negated rule spells a path under the
// directory; BuildKit's, in tonistiigi/fsutil, does the same with a trailing
// `/**` or `/*` dropped from the rule, unless a negated rule has a wildcard,
// when it prunes nothing.
function dockerWalkers(rules: DockerRule[]): DockerWalker[] {
  const spares = (patterns: string[]) => (directory: string) =>
    patterns.some((pattern) => `${pattern}/`.startsWith(`${directory}/`))
  const negated = rules.filter((rule) => rule.negated).map((rule) => rule.pattern)
  const plain = negated.map((pattern) => pattern.replace(/\/\*\*$/, "").replace(/\/\*$/, ""))
  const wildcard = plain.some((pattern) => /[*[\]?^\\]/.test(pattern))
  return [
    { name: "the legacy builder", descends: spares(negated) },
    { name: "BuildKit", descends: wildcard ? () => true : spares(plain) },
  ]
}

// The builders whose context walker leaves a file out under a .dockerignore:
// each walks down to the file, matching every directory on the way, and
// loses the file at an excluded directory it prunes or at the file's own
// exclusion.
export function dockerDrops(dockerignore: string, file: string): string[] {
  const rules = dockerignore.split("\n").flatMap((line) => dockerRule(line) ?? [])
  const segments = file.split("/")
  return dockerWalkers(rules).flatMap(({ name, descends }) => {
    let parent: DockerExclusion | undefined
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const candidate = segments.slice(0, depth).join("/")
      const match = dockerExclusion(rules, candidate, parent)
      if (match.excluded && (depth === segments.length || !descends(candidate))) return [name]
      parent = match
    }
    return []
  })
}

// Whether Docker leaves a file out of the build context under a
// .dockerignore, the same under either builder; a file one builder keeps
// and the other drops is an error, since the image would then depend on
// which builder made it.
export function dockerIgnores(dockerignore: string, file: string): boolean {
  const drops = dockerDrops(dockerignore, file)
  if (drops.length === 1) throw new Error(`${drops[0]} alone drops ${file} from the Docker context`)
  return drops.length > 0
}
