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
import { slugifyFilePath } from "./quartz/util/path"

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

function configLiteral(pattern: RegExp, what: string): string {
  const match = pattern.exec(quartzConfig)
  assert(match, `could not find ${what} in quartz.config.ts`)
  return match[1]
}

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
// sitemap when ContentIndex enables them, and the 404 page when NotFoundPage
// is configured. Read from the config so that turning a feed off turns the
// footer link into a failure here.
function emitterOutputs(): string[] {
  const outputs: string[] = []
  const contentIndex = /Plugin\.ContentIndex\(\{([\s\S]*?)\}\)/.exec(quartzConfig)?.[1] ?? ""
  if (/enableRSS:\s*true/.test(contentIndex)) {
    outputs.push(`${/rssSlug:\s*"([^"]+)"/.exec(contentIndex)?.[1] ?? "index"}.xml`)
  }
  if (/enableSiteMap:\s*true/.test(contentIndex)) outputs.push("sitemap.xml")
  if (/Plugin\.NotFoundPage\(/.test(quartzConfig)) outputs.push("404")
  return outputs
}

// Quartz's RemoveDrafts filter drops notes whose frontmatter says draft.
// The path is one of the build's own glob results under content/, not input,
// which is why the path-traversal pattern below does not apply.
function isPublished(file: string): boolean {
  // nosemgrep: javascript.pathtraversal.rule-non-literal-fs-filename
  const { draft } = matter(fs.readFileSync(path.join("content", file), "utf8")).data
  return draft !== true && draft !== "true"
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

// Every URL the site can serve, as Quartz slugs, derived the way the build
// derives them: the same glob and ignore patterns, drafts removed, a folder
// page for every ancestor folder of a published note, assets at their own
// paths, and the files the configured emitters always write. Tag pages are
// not modelled, so a footer link to one fails here and gets looked at.
async function generatedSlugs(): Promise<Set<string>> {
  const slugs = new Set<string>(emitterOutputs())
  for (const file of await glob("**/*.*", "content", configuredIgnorePatterns())) {
    if (file.endsWith(".md") && !isPublished(file)) continue
    const slug = slugifyFilePath(file)
    slugs.add(slug)
    if (file.endsWith(".md")) folderSlugs(slug).forEach((folder) => slugs.add(folder))
  }
  return slugs
}

// The slug a footer href addresses on this site. Off-site hosts and paths
// outside the configured prefix are rejected: the footer promises pages this
// site generates, not pages that merely exist somewhere.
function slugOfUrl(href: string): string {
  const { host, prefix } = configuredBase()
  const url = new URL(href, `https://${host}/`)
  assert.strictEqual(url.host, host, `${href} is not on the configured site ${host}`)
  let pathname = decodeURIComponent(url.pathname).replace(/^\/+/, "").replace(/\/+$/, "")
  if (prefix !== "") {
    assert(
      pathname === prefix || pathname.startsWith(`${prefix}/`),
      `${href} is outside /${prefix}`,
    )
    pathname = pathname.slice(prefix.length).replace(/^\/+/, "")
  }
  return pathname === "" ? "index" : pathname
}

describe("footer", () => {
  test("every footer link points at a page the site generates", async () => {
    const slugs = await generatedSlugs()
    for (const [text, href] of Object.entries(footerLinks)) {
      const slug = slugOfUrl(href)
      assert(
        slugs.has(slug),
        `footer link ${text} -> ${href}: no generated page at "${slug}" (slugs are case-sensitive on GitHub Pages)`,
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
