import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "vercel-dist");

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

for (const entry of ["index.html", "app.js", "style.css", "assets"]) {
  const source = path.join(root, entry);
  const target = path.join(dist, entry);
  fs.cpSync(source, target, { recursive: true });
}
