module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy("src/css");
  eleventyConfig.addPassthroughCopy("src/admin");
  eleventyConfig.addPassthroughCopy("src/assets");
  eleventyConfig.addPassthroughCopy("src/CNAME");

  // Make previous bulletins available as a collection
  eleventyConfig.addCollection("previousBulletins", function (collectionApi) {
    return collectionApi
      .getFilteredByGlob("src/previous/*.njk")
      .sort((a, b) => b.date - a.date);
  });

  // Format date filter
  eleventyConfig.addFilter("readableDate", (dateStr) => {
    const d = new Date(dateStr + "T12:00:00");
    return d.toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  });

  eleventyConfig.addFilter("isoDate", (dateStr) => {
    return new Date(dateStr + "T12:00:00").toISOString().split("T")[0];
  });

  eleventyConfig.addFilter("urlencode", (str) => encodeURIComponent(str));

  // Short month from date string (e.g. "2026-04-20" -> "APR")
  eleventyConfig.addFilter("shortMonth", (dateStr) => {
    const d = new Date(dateStr + "T12:00:00");
    return d.toLocaleDateString("en-US", { month: "short" }).toUpperCase();
  });

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
