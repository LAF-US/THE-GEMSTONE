// A resolve hook for the site tests. Quartz's transformers import the inline
// scripts and stylesheets they ship to the browser, which Quartz's esbuild
// build loads as text and Node cannot load at all. Each resolves here to an
// empty module, which is all the text and Markdown stages the tests run need.
// site.note-reader.ts registers it before importing the transformers.
import type { ResolveHook } from "node:module"

const browserAssets = [".inline", ".inline.ts", ".inline.js", ".scss"]

export const resolve: ResolveHook = (specifier, context, next) => {
  if (browserAssets.some((ending) => specifier.endsWith(ending))) {
    return { url: 'data:text/javascript,export default ""', shortCircuit: true }
  }
  return next(specifier, context)
}
