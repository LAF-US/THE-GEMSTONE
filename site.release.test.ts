// Tests for The Gemstone's release boundaries: what leaves the repository in
// a Docker build context or an npm package. Run with `npm test`, which runs
// from the repository root, so every path below is a literal relative to it.
// site.docker-context.ts ports what Docker does with a .dockerignore;
// site.precommit.test.ts covers pre-commit.ci and site.footer.test.ts the
// footer links.
import test, { describe } from "node:test"
import assert from "node:assert"
import fs from "node:fs"
import { dockerDrops, dockerIgnores } from "./site.docker-context"

// Non-empty, non-comment lines of a small config file, trimmed.
function configLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
}

describe("release boundaries", () => {
  test(".dockerignore keeps git history for page dates and drops local state", () => {
    const dockerignore = fs.readFileSync(".dockerignore", "utf8")
    // CreatedModifiedDate opens the repository with @napi-rs/simple-git and
    // walks the commit history for each note, which needs the whole layout git
    // documents in gitrepository-layout(5), not HEAD alone: the config, the
    // refs and packed refs, loose and packed objects, and the shallow file a
    // CI checkout leaves. A partial exclusion such as `.git/objects`, or
    // `.git/*` with `!.git/HEAD`, would find a repository it cannot read, and
    // `.git` with `!**/HEAD` would keep HEAD under BuildKit but nothing under
    // the legacy builder, which prunes `.git` without looking inside. The
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

  test("the .dockerignore port prunes directories as each builder does", () => {
    // Checked against both walkers through Go: a negated rule with a wildcard
    // rescues nothing from a directory the legacy builder prunes, and rescues
    // just what it matches under BuildKit, which then prunes nothing; a
    // negated rule spelling a path keeps that path under either.
    assert.deepStrictEqual(dockerDrops(".git\n!**/HEAD", ".git/HEAD"), ["the legacy builder"])
    assert.deepStrictEqual(dockerDrops(".git\n!**/HEAD", ".git/config"), [
      "the legacy builder",
      "BuildKit",
    ])
    assert.deepStrictEqual(dockerDrops(".git\n!.git/HEAD", ".git/HEAD"), [])
    assert.deepStrictEqual(dockerDrops(".git\n!.git/HEAD", ".git/config"), [
      "the legacy builder",
      "BuildKit",
    ])
    assert.deepStrictEqual(dockerDrops(".git\n!.git/objects/*", ".git/objects/6a/677c"), [])
    assert.throws(
      () => dockerIgnores(".git\n!**/HEAD", ".git/HEAD"),
      /the legacy builder alone drops/,
    )
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
