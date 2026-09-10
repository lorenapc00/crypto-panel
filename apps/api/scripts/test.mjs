import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const database = process.argv.includes("--db");
if (database && !process.env.TEST_DATABASE_URL) throw new Error("Set TEST_DATABASE_URL to run isolated PostgreSQL integration tests");
const root = fileURLToPath(new URL(database ? "../test/" : "../src/", import.meta.url));
async function discover(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await discover(path));
    else if (entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files.sort();
}
const files = await discover(root);
if (!files.length) throw new Error("No tests discovered");
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-reporter=tap", ...files], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
const count = Number(/^# tests (\d+)$/m.exec(result.stdout ?? "")?.[1] ?? 0);
const skipped = Number(/^# skipped (\d+)$/m.exec(result.stdout ?? "")?.[1] ?? 0);
const minimum = database ? 52 : 86;
if (result.error || result.status !== 0 || count < minimum || skipped) {
  console.error(`Test run failed or incomplete: ${count} cases, minimum ${minimum}, ${skipped} skipped`);
  process.exitCode = 1;
} else console.log(`Verified ${count} executed test cases from ${files.length} files.`);
