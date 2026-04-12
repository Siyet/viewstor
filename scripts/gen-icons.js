const path = require("path");
const svgtofont = require("svgtofont").default;

const src = path.resolve(__dirname, "..", "resources", "icon-font-src");
const dist = path.resolve(__dirname, "..", "resources", "viewstor-icons");

console.log("Source:", src);
console.log("Output:", dist);

svgtofont({
  src,
  dist,
  fontName: "viewstor-icons",
  css: false,
  startUnicode: 0xe001,
  svgicons2svgfont: {
    fontHeight: 1024,
    normalize: true,
  },
})
  .then(() => {
    console.log("Font generated successfully!");
    const fs = require("fs");
    const files = fs.readdirSync(dist);
    console.log("Generated files:", files);
  })
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });
