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

// The FrontMatter transformer's reading of a list-valued field: the first of
// the given keys that is set, as an array of strings, or nothing.
function listField(data: Record<string, unknown>, keys: string[]): string[] {
  const value = keys.map((key) => data[key]).find((v) => v !== undefined && v !== null)
  if (value === undefined) return []
  const items = Array.isArray(value) ? value : String(value).split(",")
  return items
    .filter((item) => typeof item === "string" || typeof item === "number")
    .map((item) => String(item).trim())
}

// The slugs AliasRedirects writes redirect pages at: each alias slugified as
// the FrontMatter transformer does (as a note path), the permalink as given,
// and relative ones resolved against the note's own slug.
function aliasSlugs(data: Record<string, unknown>, noteSlug: FullSlug): string[] {
  const targets: string[] = listField(data, ["aliases", "alias"]).map((alias) =>
    slugifyFilePath((alias.endsWith(".md") ? alias : `${alias}.md`) as FilePath),
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

// Every URL the site can serve, as Quartz slugs, derived the way the build
// derives them: the same glob and ignore patterns, drafts removed, a folder
// page for every ancestor folder of a published note, a redirect page for
// every alias and permalink, a tag page for every tag and the tag index,
// assets at their own paths, and the files the configured emitters always
// write.
async function generatedSlugs(): Promise<Set<string>> {
  const slugs = new Set<string>(emitterOutputs())
  for (const file of await glob("**/*.*", "content", configuredIgnorePatterns())) {
    const slug = slugifyFilePath(file)
    if (!file.endsWith(".md")) {
      slugs.add(slug)
      continue
    }
    const data = frontmatterOf(file)
    if (isDraft(data)) continue
    slugs.add(slug)
    slugs.add("tags")
    for (const extra of [...folderSlugs(slug), ...aliasSlugs(data, slug), ...tagSlugs(data)]) {
      slugs.add(extra)
    }
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
