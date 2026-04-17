const fs = require("fs");
const path = require("path");

module.exports = function () {
  const dir = path.join(__dirname, "previous");
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      return { date: raw.date, theme: raw.theme || "" };
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));
};
