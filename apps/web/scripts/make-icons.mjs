// Dev-only: regenerates the favicon and Apple touch icon from the brand logo.
// Run with `pnpm --filter @threadline/web icons`; the outputs are committed.
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const pub = (name) => fileURLToPath(new URL(`../public/${name}`, import.meta.url));
const logo = pub("logo.png");
const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

await sharp(logo).resize(32, 32, { fit: "contain", background: transparent }).png().toFile(pub("favicon-32.png"));
// iOS fills transparency with black, so the touch icon gets a white square behind the mark.
await sharp(logo)
  .resize(148, 148, { fit: "contain", background: transparent })
  .extend({ top: 16, bottom: 16, left: 16, right: 16, background: { r: 255, g: 255, b: 255, alpha: 1 } })
  .flatten({ background: "#ffffff" })
  .png()
  .toFile(pub("apple-touch-icon.png"));
console.log("wrote favicon-32.png and apple-touch-icon.png");
