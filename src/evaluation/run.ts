import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderReport, runEvaluation } from "./evaluate.js";

const summary = runEvaluation();
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const jsonPath = resolve(root, "evaluations/results/latest.json");
const reportPath = resolve(root, "evaluations/REPORT.md");

mkdirSync(dirname(jsonPath), { recursive: true });
writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(reportPath, renderReport(summary));
console.log(JSON.stringify(summary, null, 2));
