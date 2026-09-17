// Tests for the reader the site tests use on quartz.config.ts, run on small
// configs written here rather than on the site's own. Run with `npm test`.
import test, { describe } from "node:test"
import assert from "node:assert"
import { configReader } from "./site.config-reader"

// A config in Quartz's shape with the given emitters and configuration, and
// any further text inside its plugins object.
function config(emitters: string, configuration = 'baseUrl: "example.org"', more = ""): string {
  return [
    'import * as Plugin from "./quartz/plugins"',
    "const config = {",
    `  configuration: { ${configuration} },`,
    "  plugins: {",
    "    transformers: [Plugin.FrontMatter()],",
    "    filters: [],",
    `    emitters: [${emitters}],`,
    `    ${more}`,
    "  },",
    "}",
    "export default config",
  ].join("\n")
}

describe("config reader", () => {
  test("counts a plugin only while its call is written in a plugins array", () => {
    const reader = configReader(
      config(
        "Plugin.ContentIndex({ enableRSS: false }), // Plugin.Favicon(),\n /* Plugin.CNAME() */",
      ),
    )
    assert(reader.configured("ContentIndex"))
    assert(reader.configured("FrontMatter"))
    assert(!reader.configured("Favicon"))
    assert(!reader.configured("CNAME"))
    assert.deepStrictEqual(reader.configuredOptions("ContentIndex"), { enableRSS: false })
    assert.deepStrictEqual(reader.configuredOptions("FrontMatter"), {})
  })

  test("refuses a plugins array or an option it cannot read as written", () => {
    const spread = "...(enableRss ? [Plugin.ContentIndex()] : [])"
    assert.throws(() => configReader(config(spread)), /not a plugin written as Plugin\.Name/)
    assert.throws(() => configReader(config("feed")), /not a plugin written as Plugin\.Name/)
    const reader = configReader(config("Plugin.ContentIndex(options)"))
    assert.throws(() => reader.configuredOptions("ContentIndex"), /not given an object/)
    const twice = configReader(config("Plugin.Favicon(), Plugin.Favicon()"))
    assert.throws(() => twice.configuredOptions("Favicon"), /found 2/)
    const stray = config("", undefined, "extra: [Plugin.Favicon()],")
    assert.throws(() => configReader(stray), /plugins\.extra is not a plugin array Quartz runs/)
  })

  test("reads the site settings as the literals they are", () => {
    const patterns = '["private", "[Tt]emplates", "don\'t", \'single\', `tick`, // "quoted" ,]\n ]'
    const reader = configReader(
      config("", `baseUrl: "example.org/site", ignorePatterns: ${patterns}`),
    )
    assert.deepStrictEqual(reader.configuredBase(), { host: "example.org", prefix: "site" })
    assert.deepStrictEqual(reader.configuredIgnorePatterns(), [
      "private",
      "[Tt]emplates",
      "don't",
      "single",
      "tick",
    ])
  })
})
