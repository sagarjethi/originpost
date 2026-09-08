import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const failures = [];
const requiredFiles = [
  ".dockerignore",
  ".env.example",
  ".gitleaks.toml",
  ".gitignore",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "docker-compose.yml",
  "pnpm-lock.yaml",
];

for (const file of requiredFiles) {
  if (!existsSync(file) || !lstatSync(file).isFile()) failures.push(`Missing required public-release file: ${file}`);
}

let files = [];
try {
  files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
} catch {
  failures.push("Could not enumerate the public Git worktree with git ls-files.");
}

const forbiddenFiles = new Set([".env", ".env.local", ".env.development", ".env.production", ".env.test"]);
for (const file of files) {
  if (forbiddenFiles.has(file) || file.endsWith(".pem") || file.endsWith(".key")) {
    failures.push(`Private credential file would be published: ${file}`);
  }
  try {
    if (lstatSync(file).isSymbolicLink()) {
      failures.push(`Symlinks are not allowed in the public release candidate: ${file}`);
    }
  } catch {
    failures.push(`Release candidate file cannot be read: ${file}`);
  }
}

const textExtensions = new Set(["", ".css", ".html", ".js", ".json", ".jsx", ".md", ".mjs", ".sql", ".svg", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml"]);
const forbiddenContent = [
  { label: "macOS personal absolute path", pattern: /\/Users\/[A-Za-z0-9._-]+\//g },
  { label: "Linux personal absolute path", pattern: /\/home\/[A-Za-z0-9._-]+\//g },
  { label: "private OriginPost knowledge-base reference", pattern: new RegExp(`\\b${"originpost"}-${"local"}\\b`, "gi") },
  { label: "customer-specific publisher identity", pattern: new RegExp(`\\b(?:${"WING" + " NEWS"}|${"Wing" + "News"}${"Gujarat"}|${"wing" + "news"}${"gujarat"}|${"wing" + "news"})\\b`, "gi") },
  { label: "workspace-owner personal identifier", pattern: new RegExp(`\\b${"sagar"}${"jethi"}\\b`, "gi") },
];

for (const file of files) {
  if (!textExtensions.has(extname(file).toLowerCase())) continue;
  if (!existsSync(file) || statSync(file).size > 2 * 1024 * 1024) continue;
  const body = readFileSync(file, "utf8");
  if (body.includes("\0")) continue;
  for (const rule of forbiddenContent) {
    rule.pattern.lastIndex = 0;
    const match = rule.pattern.exec(body);
    if (!match) continue;
    const line = body.slice(0, match.index).split("\n").length;
    failures.push(`${rule.label} in ${file}:${line}`);
  }
}

if (existsSync("package.json")) {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
  if (packageJson.license !== "AGPL-3.0-only") failures.push("package.json must declare AGPL-3.0-only.");
  if (packageJson.private !== true) failures.push("The alpha root package must remain private to prevent accidental registry publication.");
}

if (failures.length) {
  console.error("Public-release audit failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Public-release audit passed for ${files.length} candidate files.`);
