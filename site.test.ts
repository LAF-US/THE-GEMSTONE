// Tests for The Gemstone's own site configuration, as opposed to the Quartz
// framework under quartz/. Run with `npm test`.
import test, { describe } from "node:test"
import assert from "node:assert"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import yaml from "js-yaml"
import { footerLinks } from "./site.links"
import { FilePath, slugifyFilePath } from "./quartz/util/path"

const root = path.dirname(fileURLToPath(import.meta.url))

function readLines(file: string): string[] {
  return fs
    .readFileSync(path.join(root, file), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
}

function walk(dir: string, rel = ""): { files: string[]; dirs: string[] } {
  const files: string[] = []
  const dirs: string[] = []
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) {
      dirs.push(relPath)
      const nested = walk(dir, relPath)
      files.push(...nested.files)
      dirs.push(...nested.dirs)
    } else {
      files.push(relPath)
    }
  }
  return { files, dirs }
}

// Every URL the site can serve, as Quartz slugs. Content files and folders
// come from content/; the rest are files the emitters in quartz.config.ts
// always write.
function generatedSlugs(): Set<string> {
  const { files, dirs } = walk(path.join(root, "content"))
  const slugs = new Set<string>(["index.xml", "sitemap.xml"])
  for (const file of files) slugs.add(slugifyFilePath(file as FilePath))
  for (const dir of dirs)
    slugs.add(slugifyFilePath(`${dir}/index.md` as FilePath).replace(/\/index$/, ""))
  return slugs
}

function slugOfUrl(href: string): string {
  const pathname = decodeURIComponent(new URL(href).pathname)
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
  return pathname === "" ? "index" : pathname
}

describe("footer", () => {
  test("every footer link points at a page the site generates", () => {
    const slugs = generatedSlugs()
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
    const rules = readLines(".dockerignore")
    assert(
      !rules.includes(".git"),
      "CreatedModifiedDate reads page dates from git; .git must stay in the Docker context",
    )
    for (const rule of [".npmrc", "node_modules", "public"]) {
      assert(rules.includes(rule), `.dockerignore should exclude ${rule}`)
    }
  })

  test(".npmignore ignores everything and package.json is private", () => {
    assert.deepStrictEqual(readLines(".npmignore"), ["*"])
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
    assert.strictEqual(
      pkg.private,
      true,
      "package.json must stay private; that is what stops npm publish",
    )
  })

  test("pre-commit.ci runs read-only hooks and never rewrites a branch", () => {
    const cfg = yaml.load(fs.readFileSync(path.join(root, ".pre-commit-config.yaml"), "utf8"), {
      schema: yaml.JSON_SCHEMA,
    }) as {
      ci: { autofix_prs: boolean }
      repos: { hooks: { id: string }[] }[]
    }
    assert.strictEqual(cfg.ci.autofix_prs, false)
    const readOnly = new Set([
      "check-merge-conflict",
      "check-symlinks",
      "check-yaml",
      "detect-private-key",
    ])
    for (const id of cfg.repos.flatMap((repo) => repo.hooks.map((hook) => hook.id))) {
      assert(readOnly.has(id), `hook ${id} is not in the read-only set`)
    }
  })
})
