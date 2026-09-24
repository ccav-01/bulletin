module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy("src/css");
  eleventyConfig.addPassthroughCopy("src/admin");
  eleventyConfig.addPassthroughCopy("src/assets");
  eleventyConfig.addPassthroughCopy("src/CNAME");
  eleventyConfig.addPassthroughCopy("src/.well-known");

  const nunjucks = require("nunjucks");
  eleventyConfig.setLibrary("njk", new nunjucks.Environment(new nunjucks.FileSystemLoader("src/_includes"), { autoescape: true }));
  const { filters } = require("./lib/bulletin");
  Object.entries(filters).forEach(([name, filter]) => eleventyConfig.addFilter(name, filter));
  eleventyConfig.addWatchTarget("lib/");
  eleventyConfig.addWatchTarget("src/admin/");
  eleventyConfig.on("eleventy.after", require("./scripts/build-preview"));

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
      data: "_data",
    },
    templateFormats: ["njk", "html"],
    htmlTemplateEngine: "njk",
  };
};
