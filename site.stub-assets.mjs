// A resolve hook for the site tests. Quartz's transformers import the inline
// scripts and stylesheets they ship to the browser, which Quartz's esbuild
// build loads as text and Node cannot load at all. Each resolves here to an
// empty module, which is all the text and Markdown stages the tests run need.
// site.note-reader.ts registers it before importing the transformers.
export async function resolve(specifier, context, next) {
  if (/\.inline(\.ts|\.js)?$/.test(specifier) || specifier.endsWith(".scss")) {
    return { url: 'data:text/javascript,export default ""', shortCircuit: true }
  }
  return next(specifier, context)
}
