import { expect, test } from "vitest";
import { parseRules } from "../src/rules.ts";

test("top-level bullets are rules; indented lines continue them; fences are skipped", () => {
  const md = `# Rules

- Never edit generated files in \`dist/\`.
- Migrations are append-only:
  write a new one instead of editing.
* No new runtime dependencies.

\`\`\`
- not a rule
\`\`\`
1. Keep commits atomic.
`;
  expect(parseRules(md)).toEqual([
    "Never edit generated files in `dist/`.",
    "Migrations are append-only: write a new one instead of editing.",
    "No new runtime dependencies.",
    "Keep commits atomic.",
  ]);
});
