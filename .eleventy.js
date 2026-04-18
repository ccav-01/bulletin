const QRCode = require("qrcode");

module.exports = function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy("src/css");
  eleventyConfig.addPassthroughCopy("src/admin");
  eleventyConfig.addPassthroughCopy("src/assets");
  eleventyConfig.addPassthroughCopy("src/CNAME");
  eleventyConfig.addPassthroughCopy("src/.well-known");

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

  eleventyConfig.addAsyncFilter("qrDataUri", async (url) => {
    if (!url) return "";
    return await QRCode.toDataURL(url, {
      width: 160,
      margin: 1,
      color: { dark: "#0B0B0C", light: "#F7F3EC" },
    });
  });

  // Short month from date string (e.g. "2026-04-20" -> "APR")
  eleventyConfig.addFilter("shortMonth", (dateStr) => {
    const d = new Date(dateStr + "T12:00:00");
    return d.toLocaleDateString("en-US", { month: "short" }).toUpperCase();
  });

  // Day number from date string (e.g. "2026-04-20" -> "20")
  eleventyConfig.addFilter("dayNumber", (dateStr) => {
    return new Date(dateStr + "T12:00:00").getDate();
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
