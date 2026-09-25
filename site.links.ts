// Footer links for The Gemstone. They live apart from quartz.layout.ts so a
// test can import them without pulling in Quartz components and their
// stylesheets. site.footer.test.ts checks that every one of them resolves to a
// page the site actually generates; GitHub Pages URLs are case-sensitive.
export const footerLinks: Record<string, string> = {
  HOME: "https://thegemstone.org/",
  ABOUT: "https://thegemstone.org/About",
  RSS: "https://thegemstone.org/index.xml",
}
