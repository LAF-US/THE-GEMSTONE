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
// and their stylesheets, which only the esbuild pipeline can load. The ignore
// list is a one-line array literal, so it is read from the source text and the
// test fails loudly if that ever stops being true.
function configuredIgnorePatterns(): string[] {
  const source = fs.readFileSync("quartz.config.ts", "utf8")
  const match = /ignorePatterns:\s*(\[[^\]]*\])/.exec(source)
  assert(match, "could not find ignorePatterns in quartz.config.ts")
  return JSON.parse(match[1].replace(/'/g, '"').replace(/,\s*\]/, "]"))
}

// Every URL the site can serve, as Quartz slugs, derived the way the build
// derives them: the same glob and ignore patterns, drafts removed, a folder
// page for every ancestor folder of a published note, assets at their own
// paths, and the files the emitters in quartz.config.ts always write. Tag
// pages are not modelled, so a footer link to one fails here and gets looked at.
async function generatedSlugs(): Promise<Set<string>> {
  const slugs = new Set<string>(["index.xml", "sitemap.xml", "404"])
  for (const file of await glob("**/*.*", "content", configuredIgnorePatterns())) {
    if (!file.endsWith(".md")) {
      slugs.add(slugifyFilePath(file))
      continue
    }
    const { draft } = matter(fs.readFileSync(path.join("content", file), "utf8")).data
    if (draft === true || draft === "true") continue
    const slug = slugifyFilePath(file)
    slugs.add(slug)
    for (let folder = path.dirname(slug); folder !== "."; folder = path.dirname(folder)) {
      if (folder !== "tags") slugs.add(folder)
    }
  }
  return slugs
}

function slugOfUrl(href: string): string {
  const pathname = decodeURIComponent(new URL(href).pathname)
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
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
