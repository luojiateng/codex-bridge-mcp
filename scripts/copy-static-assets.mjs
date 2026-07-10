import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const assets = [
  {
    from: path.join(root, "src", "storage", "schema.sql"),
    to: path.join(root, "dist", "storage", "schema.sql"),
  },
];

for (const asset of assets) {
  fs.mkdirSync(path.dirname(asset.to), { recursive: true });
  fs.copyFileSync(asset.from, asset.to);
}

console.log("Copied static assets into dist/.");
