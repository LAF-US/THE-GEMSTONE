// Reads a note under content/ the way Quartz's transformers read it, for the
// site tests: its frontmatter as the FrontMatter transformer leaves it, the
// tags ObsidianFlavoredMarkdown adds from its text, and the values the
// emitters derive from them. Every path is one of the build's own glob
// results under content/, not input; .codacy.yaml records why this file is
// outside Opengrep's input-surface rules.
import assert from "node:assert"
import fs from "node:fs"
import path from "node:path"
import matter from "gray-matter"
import yaml from "js-yaml"
import toml from "toml"
import remarkParse from "remark-parse"
import { unified } from "unified"
import { configured, configuredBefore, configuredOptions } from "./site.config-reader"
import {
  FilePath,
  FullSlug,
  getAllSegmentPrefixes,
  getFileExtension,
  isRelativeURL,
  joinSegments,
  simplifySlug,
  slugTag,
  slugifyFilePath,
  splitAnchor,
} from "./quartz/util/path"

export type Frontmatter = Record<string, unknown>

// ObsidianFlavoredMarkdown's text-level patterns, copied from ofm.ts, which
// cannot be imported here: it loads scripts and styles only esbuild can.
const commentRegex = /%%[\s\S]*?%%/g
const calloutLineRegex = /^> *\[\!\w+\|?.*?\][+-]?.*$/gm
const wikilinkRegex = /!?\[\[([^\[\]\|\#\\]+)?(#+[^\[\]\|\#\\]+)?(\\?\|[^\[\]\#]*)?\]\]/g
const tableRegex = /^\|([^\n])+\|\n(\|)( ?:?-{3,}:? ?\|)+\n(\|([^\n])+\|\n?)+/gm
const tableWikilinkRegex = /(!?\[\[[^\]]*?\]\]|\[\^[^\]]*?\])/g
const externalLinkRegex = /^https?:\/\//i

// A wikilink inside a table as the text transform escapes it: its `#`, and
// any `|` not already escaped.
function escapedInTable(_value: string, raw = ""): string {
  return raw.replace("#", "\\#").replace(/((^|[^\\])(\\\\)*)\|/g, "$1\\|")
}

// A wikilink as the text transform rewrites it: its anchor slugged, a block
// reference kept, its alias or heading shown, and an external target turned
// into a Markdown link.
function rewrittenWikilink(value: string, rawFp = "", rawHeader = "", rawAlias?: string): string {
  const [fp, anchor] = splitAnchor(rawFp + rawHeader)
  const blockRef = rawHeader.startsWith("#^") ? "^" : ""
  const displayAnchor = anchor ? `#${blockRef}${anchor.trim().replace(/^#+/, "")}` : ""
  const displayAlias = rawAlias ?? rawHeader.replace("#", "|")
  const embedDisplay = value.startsWith("!") ? "!" : ""
  if (externalLinkRegex.test(rawFp)) {
    return `${embedDisplay}[${displayAlias.replace(/^\|/, "")}](${rawFp})`
  }
  return `${embedDisplay}[[${fp}${displayAnchor}${displayAlias}]]`
}

// A note's source as ObsidianFlavoredMarkdown's textTransform leaves it,
// which parseMarkdown applies to the whole note, frontmatter included,
// before anything parses it: comments removed, a callout title given its own
// line, and wikilinks normalised, each when its option is on, as all are by
// default. OxHugoFlavouredMarkdown's text transform is not mirrored.
export function textTransformed(source: string): string {
  assert(!configured("OxHugoFlavouredMarkdown"), "OxHugoFlavouredMarkdown is not mirrored")
  if (!configured("ObsidianFlavoredMarkdown")) return source
  const defaults = { comments: true, callouts: true, wikilinks: true }
  const options = { ...defaults, ...configuredOptions("ObsidianFlavoredMarkdown") }
  let text = source
  if (options.comments) text = text.replace(commentRegex, "")
  if (options.callouts) text = text.replace(calloutLineRegex, (line) => `${line}\n> `)
  if (options.wikilinks) {
    text = text.replace(tableRegex, (table) => table.replace(tableWikilinkRegex, escapedInTable))
    text = text.replace(wikilinkRegex, rewrittenWikilink)
  }
  return text
}

// A note's frontmatter and body, parsed the way the FrontMatter transformer
// parses them: the source trimmed first, as parseMarkdown in
// quartz/processors/parse.ts trims it before any transformer runs, and then
// through the text transform, as parseMarkdown applies it next; the same
// library, with the delimiters and language the transformer is configured
// with over its defaults; and YAML read with js-yaml's JSON schema, so a
// value shaped like a date stays the string Quartz sees.
function parsedNote(file: FilePath): { data: Frontmatter; content: string } {
  const defaults = { delimiters: "---", language: "yaml" }
  const { delimiters, language } = { ...defaults, ...configuredOptions("FrontMatter") }
  const source = textTransformed(fs.readFileSync(path.join("content", file), "utf8").trim())
  return matter(source, {
    delimiters,
    language,
    engines: {
      yaml: (s) => yaml.load(s, { schema: yaml.JSON_SCHEMA }) as object,
      toml: (s) => toml.parse(s) as object,
    },
  })
}

// The FrontMatter transformer's reading of a list-valued field, exactly as its
// coerceToArray does it: the first of the given keys that is set; a string is
// split on commas with each piece trimmed, while an array is kept as written,
// surrounding whitespace included; then only strings and numbers survive, as
// strings. An alias of " Masthead " in an array therefore slugs to -Masthead-.
function listField(data: Frontmatter, keys: string[]): string[] {
  const value = keys.map((key) => data[key]).find((v) => v !== undefined && v !== null)
  if (value === undefined) return []
  const items: unknown[] = Array.isArray(value)
    ? value
    : String(value)
        .split(",")
        .map((item) => item.trim())
  return items.filter((item) => typeof item === "string" || typeof item === "number").map(String)
}

// ObsidianFlavoredMarkdown's tag: a `#` at the start of a text node or after a
// space, then word characters, with `/` between segments.
const tagRegex = /(?<=^| )#((?:[-_\p{L}\p{Emoji}\p{M}\d])+(?:\/[-_\p{L}\p{Emoji}\p{M}\d]+)*)/gu

// A Markdown syntax tree node, as far as reading its text nodes needs.
type Tree = { type: string; value?: string; children?: Tree[] }

// The tags in the text nodes of a tree, and in its raw HTML nodes when
// asked, as ObsidianFlavoredMarkdown finds them with mdastFindReplace: a tag
// of digits and slashes only is skipped, and the rest are slugged.
function textTags(node: Tree, tags: string[], inHtml: boolean): void {
  if (node.type === "text" || (inHtml && node.type === "html")) {
    for (const match of String(node.value).matchAll(tagRegex)) {
      if (!/^[\/\d]+$/.test(match[1])) tags.push(slugTag(match[1]))
    }
  }
  for (const child of node.children ?? []) textTags(child, tags, inHtml)
}

// The tags ObsidianFlavoredMarkdown adds to a note's frontmatter from its
// body, already through the text transform, when it is configured with
// parseTags on, its default: every tag in a text node of the Markdown parsed
// as Quartz parses it, so code and link targets do not count, and, with
// enableInHtmlEmbed on, every tag in a raw HTML node as well.
export function inlineTags(body: string): string[] {
  if (!configured("ObsidianFlavoredMarkdown")) return []
  const defaults = { parseTags: true, enableInHtmlEmbed: false }
  const options = { ...defaults, ...configuredOptions("ObsidianFlavoredMarkdown") }
  if (!options.parseTags) return []
  const tags: string[] = []
  textTags(unified().use(remarkParse).parse(body) as Tree, tags, Boolean(options.enableInHtmlEmbed))
  return tags
}

// A note's frontmatter as the transformers leave it: parsed as above, with
// tags normalised the way the FrontMatter transformer normalises them and
// ObsidianFlavoredMarkdown's tags from the body appended, without repeats.
// With no FrontMatter transformer configured, no note has any, and
// ObsidianFlavoredMarkdown keeps a tag it finds only when the frontmatter is
// already there when it looks (ofm.ts checks file.data.frontmatter), which
// takes FrontMatter listed before it; listed after, the tag becomes a link
// but no tag page. Checked against a real build either way.
export function frontmatterOf(file: FilePath): Frontmatter {
  if (!configured("FrontMatter")) return {}
  const { data, content } = parsedNote(file)
  const tags = listField(data, ["tags", "tag"]).map(slugTag)
  const kept =
    configured("ObsidianFlavoredMarkdown") &&
    configuredBefore("FrontMatter", "ObsidianFlavoredMarkdown")
  data.tags = [...new Set([...tags, ...(kept ? inlineTags(content) : [])])]
  return data
}

// Whether the configured filters keep a note, as the two filters Quartz
// ships decide it: RemoveDrafts drops a note whose frontmatter says draft,
// and ExplicitPublish keeps only a note whose frontmatter says publish.
export function published(data: Frontmatter): boolean {
  const flag = (key: string) => data[key] === true || data[key] === "true"
  if (configured("RemoveDrafts") && flag("draft")) return false
  return !configured("ExplicitPublish") || flag("publish")
}

// The slugs AliasRedirects writes redirect pages at. Each alias is turned into
// a slug exactly as the FrontMatter transformer's getAliasSlugs does it: the
// transformer compares getFileExtension(alias), which returns ".md", with
// "md", so the check never matches and ".md" is always appended, and an alias
// written as "Legacy.md" ends up at Legacy.md.html. That quirk is reproduced
// here on purpose; if the transformer changes, this must change with it. The
// permalink is taken as given, and relative targets are resolved against the
// note's own slug as AliasRedirects resolves them.
export function aliasSlugs(data: Frontmatter, noteSlug: FullSlug): string[] {
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
// from the tags frontmatterOf leaves, joined under tags/ the way TagPage
// joins them.
export function tagSlugs(data: Frontmatter): string[] {
  const tags = Array.isArray(data.tags) ? data.tags.map(String) : []
  return tags.flatMap(getAllSegmentPrefixes).map((tag) => joinSegments("tags", tag))
}

// A note's socialImage as the FrontMatter transformer leaves it: set to the
// first of socialImage, image and cover that is neither undefined nor null
// when that value is truthy, and otherwise left as written, so an empty
// string or null stays. CustomOgImages then renders an image only for a note
// whose socialImage is undefined.
export function socialImageOf(data: Frontmatter): unknown {
  const keys = ["socialImage", "image", "cover"]
  const coalesced = keys.map((key) => data[key]).find((v) => v !== undefined && v !== null)
  return coalesced || data.socialImage
}
