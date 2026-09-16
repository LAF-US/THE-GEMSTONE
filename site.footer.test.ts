// Tests for The Gemstone's footer links against the pages the site generates,
// as opposed to the Quartz framework under quartz/. Run with `npm test`, which
// runs from the repository root, so every path below is a literal relative to
// it. site.release.test.ts covers the release boundaries.
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
  isAbsoluteURL,
  isRelativeURL,
  joinSegments,
  simplifySlug,
  slugTag,
  slugifyFilePath,
  stripSlashes,
} from "./quartz/util/path"

// quartz.config.ts cannot be imported here: it pulls in every Quartz component
// and their stylesheets, which only the esbuild pipeline can load. The values
// the tests need are short literals, so they are read from the source text
// with its block comments and comment-only lines removed first, so that an
// emitter or option commented out of the config is not read as configured;
// each lookup fails loudly if the literal it expects is not found.
const quartzConfig = fs
  .readFileSync("quartz.config.ts", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "")

// The first capture of `pattern` in quartz.config.ts, or a failed assertion
// naming `what` so a config edit that moves the literal is noticed at once.
function configLiteral(pattern: RegExp, what: string): string {
  const match = pattern.exec(quartzConfig)
  assert(match, `could not find ${what} in quartz.config.ts`)
  return match[1]
}

// Whether the config lists a plugin, written as `Plugin.Name(`. Each emitter
// and filter below contributes to the model only when it is configured, so
// removing one turns the footer links it served into failures here.
function configured(plugin: string): boolean {
  return new RegExp(`Plugin\\.${plugin}\\(`).test(quartzConfig)
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

// The path under public/ at which write() in quartz/plugins/emitters/helpers.ts
// lands a slug with an extension: it joins the output directory and
// `slug + ext` with joinSegments, which strips the slashes at either end of
// each segment, so a permalink of /legacy is written at legacy.html.
function written(slug: string, ext: string): string {
  return stripSlashes(slug + ext)
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
      outputs.push(written(/rssSlug:\s*"([^"]+)"/.exec(options)?.[1] ?? "index", ".xml"))
    }
    if (!/enableSiteMap:\s*false/.test(options)) outputs.push(written("sitemap", ".xml"))
  }
  if (configured("NotFoundPage")) outputs.push(written("404", ".html"))
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
// with tags normalised the way the FrontMatter transformer normalises them
// and joined under tags/ the way TagPage joins them.
function tagSlugs(data: Record<string, unknown>): string[] {
  return listField(data, ["tags", "tag"])
    .map(slugTag)
    .flatMap(getAllSegmentPrefixes)
    .map((tag) => joinSegments("tags", tag))
}

// The folder pages FolderPage writes for a note: one for every ancestor folder
// except the tags folder, which TagPage owns, each at the folder's index.
function folderSlugs(slug: string): string[] {
  const folders: string[] = []
  for (let folder = path.dirname(slug); folder !== "."; folder = path.dirname(folder)) {
    if (folder !== "tags") folders.push(joinSegments(folder, "index"))
  }
  return folders
}

// Every file the build writes under public/, by its path there, derived the
// way the configured emitters derive them: the same glob and ignore patterns,
// drafts removed when RemoveDrafts is configured, and each emitter's slug plus
// its extension. ContentPage writes a note at its slug, FolderPage writes
// every ancestor folder of a published note at the folder's index, TagPage
// writes every tag and the tag index under tags/, AliasRedirects writes every
// alias and permalink, Assets copies other files to their slug, and
// ContentIndex and NotFoundPage write their fixed files.
async function generatedFiles(): Promise<Set<string>> {
  const files = new Set<string>(emitterOutputs())
  const ignorePatterns = configuredIgnorePatterns()
  // Assets globs every non-Markdown file, with or without an extension, the
  // way assets.ts does; the build's own glob below takes only files with one.
  if (configured("Assets")) {
    for (const file of await glob("**", "content", ["**/*.md", ...ignorePatterns])) {
      files.add(written(slugifyFilePath(file), ""))
    }
  }
  for (const file of await glob("**/*.*", "content", ignorePatterns)) {
    if (!file.endsWith(".md")) continue
    const slug = slugifyFilePath(file)
    const data = frontmatterOf(file)
    if (configured("RemoveDrafts") && isDraft(data)) continue
    const pages: string[] = []
    // ContentPage skips nested index notes, which FolderPage renders at the
    // folder's own index, and notes under tags/, which only describe a tag
    // page TagPage renders when some note carries that tag.
    if (configured("ContentPage") && !slug.endsWith("/index") && !slug.startsWith("tags/")) {
      pages.push(slug)
    }
    if (configured("FolderPage")) pages.push(...folderSlugs(slug))
    if (configured("TagPage")) pages.push(joinSegments("tags", "index"), ...tagSlugs(data))
    if (configured("AliasRedirects")) pages.push(...aliasSlugs(data, slug))
    for (const page of pages) files.add(written(page, ".html"))
  }
  return files
}

// The path a footer href requests from this site, relative to the configured
// prefix, without its leading slash and with any trailing slash kept, because
// GitHub Pages answers `About` and `About/` differently. Footer.tsx renders
// each href unchanged on every page, so a relative href such as `About` or
// `./About` would resolve against whichever page it is on; only an absolute
// URL or a root-relative path means the same thing everywhere. Off-site hosts
// and paths outside the prefix are rejected: the footer promises pages this
// site generates, not pages that merely exist somewhere.
function requestedPath(href: string): string {
  assert(
    isAbsoluteURL(href) || href.startsWith("/"),
    `${href} is neither an absolute URL nor a root-relative path, so it would point somewhere different on each page`,
  )
  const { host, prefix } = configuredBase()
  const url = new URL(href, `https://${host}/`)
  assert.strictEqual(url.host, host, `${href} is not on the configured site ${host}`)
  // GitHub Pages serves the site over https only; it answers http with a
  // redirect, and any other scheme never reaches the page.
  assert.strictEqual(
    url.protocol,
    "https:",
    `${href} does not use https, which is how the site is served`,
  )
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
