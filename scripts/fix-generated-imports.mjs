import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../src/codex/generated/", import.meta.url));

for (const file of walk(root)) {
  const before = fs.readFileSync(file, "utf8");
  const after = before.replace(/from\s+["']\.\/v2\.js["']/g, 'from "./v2/index.js"').replace(
    /(from\s+["'])(\.{1,2}\/[^"']+?)(["'])/g,
    (_match, prefix, specifier, suffix) => {
      if (path.extname(specifier)) {
        return `${prefix}${specifier}${suffix}`;
      }
      const target = path.resolve(path.dirname(file), specifier);
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        return `${prefix}${specifier}/index.js${suffix}`;
      }
      return `${prefix}${specifier}.js${suffix}`;
    },
  );
  if (after !== before) {
    fs.writeFileSync(file, after, "utf8");
  }
}

console.log("Generated Codex App Server imports normalized for Node ESM.");

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      yield fullPath;
    }
  }
}
