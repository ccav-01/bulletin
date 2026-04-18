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

  eleventyConfig.addFilter("groupThisWeek", (items) => {
    if (!items || !items.length) return [];
    const dayOrder = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

    function parseTime(timeStr) {
      if (!timeStr) return 0;
      const match = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
      if (!match) return 0;
      let hours = parseInt(match[1]);
      const mins = parseInt(match[2]);
      const period = match[3].toUpperCase();
      if (period === "PM" && hours !== 12) hours += 12;
      if (period === "AM" && hours === 12) hours = 0;
      return hours * 60 + mins;
    }

    const sorted = [...items].sort((a, b) => {
      const dayDiff = dayOrder.indexOf(a.day) - dayOrder.indexOf(b.day);
      if (dayDiff !== 0) return dayDiff;
      return parseTime(a.time) - parseTime(b.time);
    });

    const groups = [];
    for (const item of sorted) {
      const last = groups[groups.length - 1];
      if (last && last.day === item.day) {
        last.items.push(item);
      } else {
        groups.push({ day: item.day, items: [item] });
      }
    }
    return groups;
  });

  eleventyConfig.addFilter("qrDataUri", (url) => {
    if (!url) return "";
    const qr = QRCode.create(url, { errorCorrectionLevel: "M" });
    const matrix = qr.modules;
    const size = matrix.size;
    const cell = 4;
    const margin = 4;
    const dim = (size + margin * 2) * cell;
    let rects = "";
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (matrix.get(r, c)) {
          rects += `<rect x="${(c + margin) * cell}" y="${(r + margin) * cell}" width="${cell}" height="${cell}"/>`;
        }
      }
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="160" height="160"><rect width="${dim}" height="${dim}" fill="#F7F3EC"/><g fill="#0B0B0C">${rects}</g></svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
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
