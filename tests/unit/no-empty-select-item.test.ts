import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// Regression guard for the prod white-screen crash: Radix <Select> THROWS at
// render if any <SelectItem> has value="" (empty string is reserved for
// "clear"), taking down the whole React tree. Use a sentinel value instead
// (e.g. "__none__"/"__all__") and map it back to "" in state. This scans the
// source tree so the bug can never silently reappear.

const ROOT = path.resolve(__dirname, "..", "..");
const SCAN_DIRS = ["app", "components"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

// Radix value-restricted items that forbid an empty-string value.
const RESTRICTED = ["SelectItem", "TabsTrigger", "RadioGroupItem"];
const emptyValueRe = (tag: string) =>
  new RegExp(`<${tag}\\b[^>]*\\bvalue=(""|\\{\\s*(""|'')\\s*\\})`);

describe("Radix value-restricted items never use an empty-string value", () => {
  const files = SCAN_DIRS.flatMap((d) => {
    const full = path.join(ROOT, d);
    return fs.existsSync(full) ? walk(full) : [];
  });

  it("scans a non-trivial number of .tsx files", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const tag of RESTRICTED) {
    it(`<${tag}> has no empty-string value across app/ + components/`, () => {
      const offenders: string[] = [];
      const re = emptyValueRe(tag);
      for (const file of files) {
        const lines = fs.readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          if (re.test(line)) {
            offenders.push(
              `${path.relative(ROOT, file)}:${i + 1}  ${line.trim()}`,
            );
          }
        });
      }
      expect(
        offenders,
        `Empty <${tag}> value crashes Radix:\n${offenders.join("\n")}`,
      ).toEqual([]);
    });
  }
});
