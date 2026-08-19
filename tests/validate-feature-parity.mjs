import { readFileSync } from "node:fs";

const files = [
  new URL("./features/panel.zh-CN.feature", import.meta.url),
  new URL("./features/panel.en.feature", import.meta.url)
];

const expected = Array.from({ length: 80 }, (_, index) =>
  `PANEL-${String(index + 1).padStart(3, "0")}`
);

const idsByFile = files.map((file) => {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/@PANEL-(\d{3})/g)].map((match) => `PANEL-${match[1]}`);
});

for (let index = 0; index < files.length; index += 1) {
  const actual = idsByFile[index];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${files[index].pathname} does not contain PANEL-001..PANEL-080 exactly once and in order`);
  }
}

if (JSON.stringify(idsByFile[0]) !== JSON.stringify(idsByFile[1])) {
  throw new Error("Chinese and English feature IDs are not aligned");
}

console.log("Feature parity OK: 80 Chinese scenarios and 80 English scenarios.");
