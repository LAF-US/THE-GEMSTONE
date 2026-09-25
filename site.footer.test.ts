// Tests for The Gemstone's footer links against the pages the site generates,
// as opposed to the Quartz framework under quartz/. Run with `npm test`, which
// runs from the repository root, so every path below is a literal relative to
// it. site.config-reader.ts reads the values it needs from quartz.config.ts,
// site.note-reader.ts runs Quartz's own transformers and filters on each
// note, and site.release.test.ts covers the release boundaries.
import test, { describe } from "node:test"
import assert from "node:assert"
import path from "node:path"
import {
  configured,
  configuredBase,
  configuredIgnorePatterns,
  configuredOptions,
} from "./site.config-reader"
import { footerLinks } from "./site.links"
import {
  aliasSlugs,
  Note,
  readNote,
  tagSlugs,
  transformedNote,
  transformedText,
} from "./site.note-reader"
import { glob } from "./quartz/util/glob"
import {
  FilePath,
  FullSlug,
  isAbsoluteURL,
  joinSegments,
  slugifyFilePath,
  stripSlashes,
} from "./quartz/util/path"

// The path under public/ at which write() in quartz/plugins/emitters/helpers.ts
// lands a slug with an extension: it joins the output directory and
// `slug + ext` with joinSegments, which strips the slashes at either end of
// each segment, so a permalink of /legacy is written at legacy.html, and the
// filesystem resolves the dot segments of the path it is handed, so a
// permalink of legacy/../old is written at old.html. A path that climbs out
// of public/ is kept as such; no request reaches it.
function written(slug: string, ext: string): string {
  return path.posix.normalize(stripSlashes(slug + ext))
}

// The files ContentIndex writes: its content index always, and the RSS feed
// and sitemap unless turned off. Its options are merged over its defaults
// the way the emitter merges them, so `Plugin.ContentIndex()` with no
// options writes both files and only an explicit `false` turns one off. Read
// from the config so that turning the feed off turns the footer link into a
// failure here.
function contentIndexOutputs(): string[] {
  if (!configured("ContentIndex")) return []
  const defaults = { enableSiteMap: true, enableRSS: true, rssSlug: "index" }
  const options = { ...defaults, ...configuredOptions("ContentIndex") }
  const outputs = [written(joinSegments("static", "contentIndex"), ".json")]
  if (options.enableRSS) outputs.push(written(String(options.rssSlug), ".xml"))
  if (options.enableSiteMap) outputs.push(written("sitemap", ".xml"))
  return outputs
}

// Files the configured emitters write regardless of content: ContentIndex's
// files, the 404 page when NotFoundPage is configured, the favicon, the CNAME
// file when that emitter is configured with a base URL, and the site
// stylesheet and scripts.
function emitterOutputs(): string[] {
  const outputs = contentIndexOutputs()
  if (configured("NotFoundPage")) outputs.push(written("404", ".html"))
  if (configured("Favicon")) outputs.push(written("favicon", ".ico"))
  if (configured("CNAME") && configuredBase().host !== "") outputs.push(written("CNAME", ""))
  // Fonts that ComponentResources caches from Google when cdnCaching is off
  // are fetched at build time and are not modelled.
  if (configured("ComponentResources")) {
    outputs.push(
      written("index", ".css"),
      written("prescript", ".js"),
      written("postscript", ".js"),
    )
  }
  return outputs
}

// The files Static copies from quartz/static to static/, with the same glob.
async function staticFiles(): Promise<string[]> {
  if (!configured("Static")) return []
  const files = await glob("**", path.join("quartz", "static"), configuredIgnorePatterns())
  return files.map((file) => written(joinSegments("static", file), ""))
}

// The files Assets copies to their slug: every non-Markdown file under
// content/, with or without an extension, globbed the way assets.ts globs
// them; the build's own glob in generatedFiles takes only files with one.
async function assetFiles(): Promise<string[]> {
  if (!configured("Assets")) return []
  const files = await glob("**", "content", ["**/*.md", ...configuredIgnorePatterns()])
  return files.map((file) => written(slugifyFilePath(file), ""))
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

// The pages the page emitters write for one published note, by slug.
// ContentPage writes the note at its own slug, skipping nested index notes,
// which FolderPage renders at the folder's own index, and notes under tags/,
// which only describe a tag page TagPage renders when some note carries that
// tag. FolderPage writes every ancestor folder, TagPage every tag and tag
// prefix, and AliasRedirects every alias and permalink.
function notePages(slug: FullSlug, note: Note): string[] {
  const pages: string[] = []
  const ownPage = !slug.endsWith("/index") && !slug.startsWith("tags/")
  if (configured("ContentPage") && ownPage) pages.push(slug)
  if (configured("FolderPage")) pages.push(...folderSlugs(slug))
  if (configured("TagPage")) pages.push(...tagSlugs(note))
  if (configured("AliasRedirects")) pages.push(...aliasSlugs(note))
  return pages
}

// The files the build writes for one note: none when a filter drops it,
// otherwise its pages and, when CustomOgImages is configured and the
// transformers leave the note without a socialImage, its social image.
async function noteFiles(file: FilePath): Promise<string[]> {
  const note = await readNote(file)
  if (!note.published) return []
  const slug = note.data.slug as FullSlug
  const files = notePages(slug, note).map((page) => written(page, ".html"))
  if (configured("CustomOgImages") && note.data.frontmatter?.socialImage === undefined) {
    files.push(written(`${slug}-og-image`, ".webp"))
  }
  return files
}

// Every file the build writes under public/, by its path there, derived the
// way the configured emitters derive them: the same glob and ignore patterns
// as the build, the same filters, and each emitter's slug plus its extension.
async function generatedFiles(): Promise<Set<string>> {
  const files = new Set([...emitterOutputs(), ...(await staticFiles()), ...(await assetFiles())])
  // TagPage always writes the tag index: computeTagInfo adds the base tag
  // whether or not any note survives the filters.
  if (configured("TagPage")) files.add(written(joinSegments("tags", "index"), ".html"))
  // The notes in the order build.ts parses them, which is the order their
  // aliases join the slugs the transformers see.
  const notes = (await glob("**/*.*", "content", configuredIgnorePatterns()))
    .filter((file) => file.endsWith(".md"))
    .sort()
  for (const file of notes) {
    for (const output of await noteFiles(joinSegments("content", file) as FilePath))
      files.add(output)
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
  test("a note's text goes through the transformers' text stages", () => {
    // Checked against a real build: with this frontmatter RemoveDrafts drops
    // the note, because the comment is gone before the frontmatter is read.
    assert.strictEqual(transformedText('draft: "%% explanation %%true"'), 'draft: "true"')
    assert.strictEqual(transformedText("> [!note] Title\ntext"), "> [!note] Title\n> \ntext")
    assert.strictEqual(transformedText("[[Note#My Heading|shown]]"), "[[Note#my-heading|shown]]")
    assert.strictEqual(
      transformedText("![[https://x.test/a.png|alt]]"),
      "![alt](https://x.test/a.png)",
    )
  })

  test("tags are read from a note's text as ObsidianFlavoredMarkdown reads them", async () => {
    // Checked against a real build: it writes tags/release.html,
    // tags/idaho/politics.html and tags/arrow.html for this text and nothing
    // for the rest. A tag inside a highlight or a wikilink alias is consumed
    // by the replacement that runs before the tag pass.
    const body = [
      "# Heading #release",
      "",
      "Body with #idaho/politics, #2024, `#code` and %% #hidden %%",
      "",
      "```",
      "#fenced",
      "```",
      "",
      "[[Note#section]], https://x.test/#frag and end#notag",
      "",
      "== #highlighted== and [[Note|#aliased]] and -> #arrow",
    ].join("\n")
    const { data } = await transformedNote("content/Probe.md" as FilePath, body)
    assert.deepStrictEqual(data.frontmatter?.tags, ["release", "idaho/politics", "arrow"])
  })

  test("an output path lands where the filesystem puts it", () => {
    // Checked against a real build: a permalink of legacy/../old is written
    // at old.html, with an empty legacy/ directory beside it.
    assert.strictEqual(written("/legacy/../old", ".html"), "old.html")
    assert.strictEqual(written("./About", ".html"), "About.html")
    assert.strictEqual(written("../outside", ".html"), "../outside.html")
  })

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
