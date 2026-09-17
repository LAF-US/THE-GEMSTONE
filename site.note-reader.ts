// Reads a note the way Quartz's build reads it, with Quartz's own code: the
// transformers and filters the config lists, imported from quartz/plugins
// and run in the config's order as quartz/processors/parse.ts and filter.ts
// run them. site.footer.test.ts derives from the result what the emitters
// write. Nothing here mirrors a transformer. The notes read are the site's
// own under content/, not input; .codacy.yaml records why this file is
// excluded from Opengrep.
import assert from "node:assert"
import fs from "node:fs"
import { register } from "node:module"
import path from "node:path"
import remarkParse from "remark-parse"
import { unified } from "unified"
import { VFile } from "vfile"
import {
  configuredConfiguration,
  configuredIgnorePatterns,
  configuredPlugins,
} from "./site.config-reader"
import type {
  QuartzFilterPluginInstance,
  QuartzTransformerPluginInstance,
} from "./quartz/plugins/types"
import type { ProcessedContent, QuartzPluginData } from "./quartz/plugins/vfile"
import type { BuildCtx } from "./quartz/util/ctx"
import { glob } from "./quartz/util/glob"
import {
  FilePath,
  getAllSegmentPrefixes,
  isRelativeURL,
  joinSegments,
  simplifySlug,
  slugifyFilePath,
} from "./quartz/util/path"

// The transformers import browser assets only Quartz's esbuild build can
// load; site.stub-assets.ts resolves each to an empty module. It must be
// registered before the imports it serves, hence the dynamic imports, and a
// new kind of asset would fail them, so the failure names the hook to extend.
let Transformers: typeof import("./quartz/plugins/transformers")
let Filters: typeof import("./quartz/plugins/filters")
try {
  register("./site.stub-assets.ts", import.meta.url)
  Transformers = await import("./quartz/plugins/transformers")
  Filters = await import("./quartz/plugins/filters")
} catch (cause) {
  const hint =
    "Quartz's plugins could not be imported; site.stub-assets.ts resolves their browser assets"
  throw new Error(hint, { cause })
}

// A plugin instance from Quartz's own module of that name, built with the
// options the config writes for it.
function instance<T>(modules: object, kind: string, name: string, options: unknown): T {
  const factory = (modules as Record<string, ((options?: unknown) => T) | undefined>)[name]
  assert(factory !== undefined, `${name} is not a ${kind} Quartz ships`)
  return factory(options)
}

// The configured transformers and filters, in order. CreatedModifiedDate is
// left out: it only dates a note, from git history it would need at hand,
// and a date decides nothing about what the build writes.
const transformers = configuredPlugins("transformers")
  .filter(({ name }) => name !== "CreatedModifiedDate")
  .map(({ name, options }) =>
    instance<QuartzTransformerPluginInstance>(Transformers, "transformer", name, options),
  )
const filters = configuredPlugins("filters").map(({ name, options }) =>
  instance<QuartzFilterPluginInstance>(Filters, "filter", name, options),
)

// The build context the plugins are handed: the configuration as written,
// the argv of a plain `npx quartz build`, and the files and slugs build.ts
// lists before parsing, every file under the content directory the config
// does not ignore. ObsidianFlavoredMarkdown checks a wikilink against the
// slugs when disableBrokenWikilinks is on, and FrontMatter adds each note's
// aliases to them as it runs.
const argv = { directory: "content", verbose: false, output: "public", serve: false, watch: false }
const allFiles = await glob("**/*.*", argv.directory, configuredIgnorePatterns())
const ctx = {
  buildId: "site-tests",
  argv: { ...argv, port: 8080, wsPort: 3001 },
  cfg: {
    configuration: configuredConfiguration(),
    plugins: { transformers, filters, emitters: [] },
  },
  allSlugs: allFiles.map((file) => slugifyFilePath(file)),
  allFiles,
  incremental: false,
} as unknown as BuildCtx

// The Markdown processor parse.ts builds: remark-parse, then each
// transformer's Markdown plugins in order. A plugin such as remark-gfm
// registers syntax the parser reads, so a note parses as the build parses
// it. The HTML stage is not run: nothing after the Markdown stage changes a
// note's frontmatter, aliases or slug, and the filters Quartz ships read
// only the frontmatter.
const processor = unified()
  .use(remarkParse)
  .use(transformers.flatMap((plugin) => plugin.markdownPlugins?.(ctx) ?? []))

// A note's text as the transformers' text stages leave it, applied in order
// to the whole file, frontmatter included, as parse.ts applies them.
export function transformedText(source: string): string {
  return transformers.reduce((text, plugin) => plugin.textTransform?.(ctx, text) ?? text, source)
}

export type Note = { data: QuartzPluginData; published: boolean }

// A note's syntax tree after the Markdown stages, or the failure of one of
// them, named for the note as parse.ts names it.
async function processed(note: VFile): Promise<ProcessedContent> {
  try {
    const tree = await processor.run(processor.parse(note), note)
    return [tree, note] as unknown as ProcessedContent
  } catch (cause) {
    throw new Error(`Failed to process markdown \`${note.path}\``, { cause })
  }
}

// A note at a path, from its source, as the transformers and filters leave
// it: the text stages, the file data parse.ts sets, the Markdown stages, and
// whether every configured filter would publish it.
export async function transformedNote(file: FilePath, source: string): Promise<Note> {
  const note = new VFile({ path: file, value: transformedText(source.trim()) })
  note.data.filePath = file
  note.data.relativePath = path.posix.relative(argv.directory, file) as FilePath
  note.data.slug = slugifyFilePath(note.data.relativePath)
  const content = await processed(note)
  const published = filters.every((filter) => filter.shouldPublish(ctx, content))
  return { data: note.data, published }
}

// A note read from the repository.
export function readNote(file: FilePath): Promise<Note> {
  return transformedNote(file, fs.readFileSync(file, "utf8"))
}

// The slugs AliasRedirects writes redirect pages at, from the aliases the
// FrontMatter transformer leaves in the file data, each alias slugged and
// the permalink as written: a relative target is resolved against the note's
// own slug as aliases.ts resolves it, and the rest are taken as they are.
export function aliasSlugs(note: Note): string[] {
  const slug = note.data.slug
  assert(slug !== undefined, `${note.data.filePath} has no slug`)
  return (note.data.aliases ?? []).map((target) =>
    isRelativeURL(target) ? path.normalize(path.join(simplifySlug(slug), "..", target)) : target,
  )
}

// The tag pages TagPage writes for a note: one per tag and per tag prefix,
// from the tags the transformers leave, joined under tags/ as TagPage joins
// them.
export function tagSlugs(note: Note): string[] {
  const tags = note.data.frontmatter?.tags ?? []
  return tags.flatMap(getAllSegmentPrefixes).map((tag) => joinSegments("tags", tag))
}
