// Tests for what pre-commit.ci may do to this repository: run read-only
// checks and report, never rewrite a pull request branch. Run with
// `npm test`, which runs from the repository root, so the path below is a
// literal relative to it. site.release.test.ts covers the other release
// boundaries.
import test, { describe } from "node:test"
import assert from "node:assert"
import fs from "node:fs"
import yaml from "js-yaml"

// A hook of a pre-commit config as parsed, and the repository entry it sits in.
type Hook = Record<string, unknown>
type Repo = { repo?: unknown; rev?: unknown; hooks?: unknown }

// The keys of these hooks that change what code a hook runs: its command, or
// the packages installed beside it. pre-commit merges a config hook over the
// manifest hook of its id, and its config schema accepts every manifest key
// but id, stages and language (CONFIG_HOOK_DICT in pre_commit/clientlib.py),
// so a config could put its own command or packages under a read-only id.
// The other keys only select files or pass arguments to the same code.
function codeOverrides(hooks: Hook[]): string[] {
  return hooks.flatMap((hook) =>
    Object.keys(hook)
      .filter((key) => key === "entry" || key === "additional_dependencies")
      .map((key) => `${hook.id}: ${key}`),
  )
}

// Whether a rev pins a repository: a version tag, as pre-commit-hooks tags
// its releases (vX.Y.Z), or a full commit id. pre-commit's own WarnMutableRev
// only warns, and counts any name with a dot as pinned, so a branch such as
// release.2026 would pass it.
function pinned(rev: unknown): boolean {
  return typeof rev === "string" && /^(?:v?\d+(?:\.\d+)+|[0-9a-f]{40})$/.test(rev)
}

describe("pre-commit.ci", () => {
  test("runs read-only hooks and never rewrites a branch", () => {
    // Parsed with a YAML safe load, as pre-commit's own yaml_load is, so a
    // hook written as a flow mapping or with quoted keys reads the same as
    // one written a key per line.
    const config = yaml.load(fs.readFileSync(".pre-commit-config.yaml", "utf8")) as {
      ci?: { autofix_prs?: unknown }
      repos?: Repo[]
    }
    assert.strictEqual(
      config.ci?.autofix_prs,
      false,
      "pre-commit.ci must not push fixes to branches",
    )
    const readOnly = new Set([
      "check-merge-conflict",
      "check-symlinks",
      "check-yaml",
      "detect-private-key",
    ])
    // The ids are the read-only checks of the pre-commit-hooks repository, so
    // every hook must come from there, at a pinned revision: a local hook or
    // another repository could put a rewriting hook under one of these ids.
    const repos = config.repos ?? []
    assert(repos.length > 0, "no repos found in .pre-commit-config.yaml")
    const hooks = repos.flatMap((repo) => {
      assert.strictEqual(repo.repo, "https://github.com/pre-commit/pre-commit-hooks")
      assert(pinned(repo.rev), `rev ${repo.rev} is not pinned`)
      assert(Array.isArray(repo.hooks), `repo ${repo.repo} lists no hooks`)
      return repo.hooks as Hook[]
    })
    assert(hooks.length > 0, "no hooks found in .pre-commit-config.yaml")
    for (const hook of hooks) {
      assert(typeof hook === "object" && hook !== null, `hook ${hook} is not a mapping`)
      assert(readOnly.has(String(hook.id)), `hook ${hook.id} is not in the read-only set`)
    }
    assert.deepStrictEqual(codeOverrides(hooks), [])
    const flow = yaml.load('[{id: check-yaml, "entry": touch x}, {id: check-symlinks}]') as Hook[]
    assert.deepStrictEqual(codeOverrides(flow), ["check-yaml: entry"])
    for (const rev of ["v6.0.0", "24.1.0", "a".repeat(40)]) assert(pinned(rev), rev)
    for (const rev of ["main", "release.2026", "v6", "abc123", undefined])
      assert(!pinned(rev), String(rev))
  })
})
