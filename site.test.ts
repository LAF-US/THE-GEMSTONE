// Tests for The Gemstone's own site configuration, as opposed to the Quartz
// framework under quartz/. Run with `npm test`, which runs from the repository
// root, so every path below is a literal relative to it.
import test, { describe } from "node:test"
import assert from "node:assert"
import fs from "node:fs"
import path from "node:path"
import matter from "gray-matter"
import { footerLinks } from "./site.links"
import { glob } from "./quartz/util/glob"
import {
  FilePath,
  FullSlug,
  getAllSegmentPrefixes,
  getFileExtension,
  isRelativeURL,
  simplifySlug,
  slugTag,
  slugifyFilePath,
} from "./quartz/util/path"

// Non-empty, non-comment lines of a small config file, trimmed.
function configLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
}

// quartz.config.ts cannot be imported here: it pulls in every Quartz component
// and their stylesheets, which only the esbuild pipeline can load. The values
// the tests need are short literals, so they are read from the source text,
// and each lookup fails loudly if the literal it expects is not found.
const quartzConfig = fs.readFileSync("quartz.config.ts", "utf8")

// The first capture of `pattern` in quartz.config.ts, or a failed assertion
// naming `what` so a config edit that moves the literal is noticed at once.
function configLiteral(pattern: RegExp, what: string): string {
  const match = pattern.exec(quartzConfig)
  assert(match, `could not find ${what} in quartz.config.ts`)
  return match[1]
}

// The ignorePatterns array the build passes to its content glob.
function configuredIgnorePatterns(): string[] {
  const literal = configLiteral(/ignorePatterns:\s*(\[[^\]]*\])/, "ignorePatterns")
  return JSON.parse(literal.replace(/'/g, '"').replace(/,\s*\]/, "]"))
}

// Host and optional path prefix the site is served from, as Quartz's baseUrl.
function configuredBase(): { host: string; prefix: string } {
  const [host, ...rest] = configLiteral(/baseUrl:\s*"([^"]+)"/, "baseUrl").split("/")
  return { host, prefix: rest.join("/") }
}

// Files the configured emitters write regardless of content: the RSS feed and
// sitemap unless ContentIndex turns them off, and the 404 page when
// NotFoundPage is configured. ContentIndex defaults enableSiteMap and
// enableRSS to true and rssSlug to "index" and merges its options over those
// defaults, so `Plugin.ContentIndex()` with no options writes both files and
// only an explicit `false` turns one off. Read from the config so that turning
// the feed off turns the footer link into a failure here.
function emitterOutputs(): string[] {
  const outputs: string[] = []
  const contentIndex = /Plugin\.ContentIndex\((?:\{([\s\S]*?)\})?\)/.exec(quartzConfig)
  if (contentIndex) {
    const options = contentIndex[1] ?? ""
    if (!/enableRSS:\s*false/.test(options)) {
      outputs.push(`${/rssSlug:\s*"([^"]+)"/.exec(options)?.[1] ?? "index"}.xml`)
    }
    if (!/enableSiteMap:\s*false/.test(options)) outputs.push("sitemap.xml")
  }
  if (/Plugin\.NotFoundPage\(/.test(quartzConfig)) outputs.push("404.html")
  return outputs
}

// A note's frontmatter, parsed by the same library Quartz's FrontMatter
// transformer uses. The path is one of the build's own glob results under
// content/, not input; .codacy.yaml records why this file is outside
// Opengrep's input-surface rules.
function frontmatterOf(file: string): Record<string, unknown> {
  return matter(fs.readFileSync(path.join("content", file), "utf8")).data
}

// Quartz's RemoveDrafts filter drops notes whose frontmatter says draft.
function isDraft(data: Record<string, unknown>): boolean {
  return data.draft === true || data.draft === "true"
}

// The FrontMatter transformer's reading of a list-valued field, exactly as its
// coerceToArray does it: the first of the given keys that is set; a string is
// split on commas with each piece trimmed, while an array is kept as written,
// surrounding whitespace included; then only strings and numbers survive, as
// strings. An alias of " Masthead " in an array therefore slugs to -Masthead-.
function listField(data: Record<string, unknown>, keys: string[]): string[] {
  const value = keys.map((key) => data[key]).find((v) => v !== undefined && v !== null)
  if (value === undefined) return []
  const items: unknown[] = Array.isArray(value)
    ? value
    : String(value)
        .split(",")
        .map((item) => item.trim())
  return items.filter((item) => typeof item === "string" || typeof item === "number").map(String)
}

// The slugs AliasRedirects writes redirect pages at. Each alias is turned into
// a slug exactly as the FrontMatter transformer's getAliasSlugs does it: the
// transformer compares getFileExtension(alias), which returns ".md", with
// "md", so the check never matches and ".md" is always appended, and an alias
// written as "Legacy.md" ends up at Legacy.md.html. That quirk is reproduced
// here on purpose; if the transformer changes, this must change with it. The
// permalink is taken as given, and relative targets are resolved against the
// note's own slug as AliasRedirects resolves them.
function aliasSlugs(data: Record<string, unknown>, noteSlug: FullSlug): string[] {
  const targets: string[] = listField(data, ["aliases", "alias"]).map((alias) =>
    slugifyFilePath((getFileExtension(alias) === "md" ? alias : `${alias}.md`) as FilePath),
  )
  if (data.permalink != null && String(data.permalink) !== "") targets.push(String(data.permalink))
  return targets.map((target) =>
    isRelativeURL(target)
      ? path.normalize(path.join(simplifySlug(noteSlug), "..", target))
      : target,
  )
}

// The tag pages TagPage writes for a note: one per tag and per tag prefix,
// with tags normalised the way the FrontMatter transformer normalises them.
function tagSlugs(data: Record<string, unknown>): string[] {
  return listField(data, ["tags", "tag"])
    .map(slugTag)
    .flatMap(getAllSegmentPrefixes)
    .map((tag) => `tags/${tag}`)
}

// FolderPage emits a page for every ancestor folder of a published note,
// except the tags folder, which TagPage owns.
function folderSlugs(slug: string): string[] {
  const folders: string[] = []
  for (let folder = path.dirname(slug); folder !== "."; folder = path.dirname(folder)) {
    if (folder !== "tags") folders.push(folder)
  }
  return folders
}

// Every file the build writes under public/, by its path there, derived the
// way the emitters derive them: the same glob and ignore patterns, drafts
// removed, and each emitter's slug plus its extension. ContentPage writes a
// note at its slug, FolderPage writes every ancestor folder of a published
// note at the folder's index, TagPage writes every tag and the tag index under
// tags/, AliasRedirects writes every alias and permalink, Assets copies other
// files to their slug, and the configured emitters write their fixed files.
async function generatedFiles(): Promise<Set<string>> {
  const files = new Set<string>(emitterOutputs())
  for (const file of await glob("**/*.*", "content", configuredIgnorePatterns())) {
    const slug = slugifyFilePath(file)
    if (!file.endsWith(".md")) {
      files.add(slug)
      continue
    }
    const data = frontmatterOf(file)
    if (isDraft(data)) continue
    // ContentPage skips nested index notes, which FolderPage renders at the
    // folder's own index, and notes under tags/, which only describe a tag
    // page TagPage renders when some note carries that tag.
    if (!slug.endsWith("/index") && !slug.startsWith("tags/")) files.add(`${slug}.html`)
    files.add("tags/index.html")
    for (const folder of folderSlugs(slug)) files.add(`${folder}/index.html`)
    for (const page of [...aliasSlugs(data, slug), ...tagSlugs(data)]) files.add(`${page}.html`)
  }
  return files
}

// The path a footer href requests from this site, relative to the configured
// prefix, without its leading slash and with any trailing slash kept, because
// GitHub Pages answers `About` and `About/` differently. Off-site hosts and
// paths outside the prefix are rejected: the footer promises pages this site
// generates, not pages that merely exist somewhere.
function requestedPath(href: string): string {
  const { host, prefix } = configuredBase()
  const url = new URL(href, `https://${host}/`)
  assert.strictEqual(url.host, host, `${href} is not on the configured site ${host}`)
  let pathname = decodeURIComponent(url.pathname).replace(/^\/+/, "")
  if (prefix !== "") {
    assert(
      pathname === prefix || pathname.startsWith(`${prefix}/`),
      `${href} is outside /${prefix}`,
    )
    pathname = pathname.slice(prefix.length).replace(/^\/+/, "")
  }
  return pathname
}

// The generated file GitHub Pages serves for a requested path, if any. These
// are its rules as checked against the live site: a file is served at its own
// path; `About.html` also answers `About` but not `About/`; `tags/index.html`
// answers `tags/`, `tags/index.html` and `tags/index`, and `tags` redirects to
// `tags/`; the empty path is the site root.
function servedFile(files: Set<string>, requested: string): string | undefined {
  const candidates =
    requested === "" || requested.endsWith("/")
      ? [`${requested}index.html`]
      : [requested, `${requested}.html`, `${requested}/index.html`]
  return candidates.find((candidate) => files.has(candidate))
}

describe("footer", () => {
  test("every footer link points at a page the site generates", async () => {
    const files = await generatedFiles()
    for (const [text, href] of Object.entries(footerLinks)) {
      const requested = requestedPath(href)
      assert(
        servedFile(files, requested) !== undefined,
        `footer link ${text} -> ${href}: the site generates nothing that serves "/${requested}" (paths are case-sensitive on GitHub Pages)`,
      )
    }
  })
})

describe("release boundaries", () => {
  test(".dockerignore keeps git history for page dates and drops local state", () => {
    const rules = configLines(fs.readFileSync(".dockerignore", "utf8"))
    assert(
      !rules.includes(".git"),
      "CreatedModifiedDate reads page dates from git; .git must stay in the Docker context",
    )
    for (const rule of [".npmrc", "node_modules", "public"]) {
      assert(rules.includes(rule), `.dockerignore should exclude ${rule}`)
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
