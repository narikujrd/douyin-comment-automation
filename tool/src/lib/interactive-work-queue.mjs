import fs from "node:fs";
import path from "node:path";
import { normalizeText } from "./common.mjs";

export function loadInteractiveWorkQueue(worksFile, maxWorks = 10) {
  const resolvedWorksFile = path.resolve(worksFile);
  const source = JSON.parse(fs.readFileSync(resolvedWorksFile, "utf8"));
  if (!Array.isArray(source?.works)) {
    throw new Error(`Works file must contain a works array: ${resolvedWorksFile}`);
  }

  const limit = Number(maxWorks);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`maxWorks must be a positive integer; received: ${maxWorks}`);
  }

  const works = source.works.slice(0, limit).map((work, index) => {
    const title = normalizeText(work?.title);
    if (!title) {
      throw new Error(`Work ${index + 1} in ${resolvedWorksFile} is missing title.`);
    }
    return {
      title,
      publishText: normalizeText(work?.publishText)
    };
  });

  if (works.length === 0) {
    throw new Error(`Works file contains no works: ${resolvedWorksFile}`);
  }

  return {
    worksFile: resolvedWorksFile,
    works
  };
}

export function getInteractiveWorkOutputPath(outputDirectory, workIndex) {
  const sequence = String(workIndex + 1).padStart(2, "0");
  return path.resolve(outputDirectory, `work-${sequence}.json`);
}

export function summarizeInteractiveWorkResults(results, exitReason = "all_works_complete") {
  const countKeys = [
    "decisionCount",
    "repliedCount",
    "sentUnconfirmedCount",
    "previewCount",
    "actedCount",
    "skippedCount",
    "errorCount",
    "totalProcessed"
  ];
  const totals = Object.fromEntries(countKeys.map((key) => [key, 0]));
  for (const result of results) {
    for (const key of countKeys) {
      totals[key] += Number(result?.[key]) || 0;
    }
  }

  return {
    exitReason,
    processedWorkCount: results.length,
    ...totals,
    works: results.map((result, index) => ({
      workIndex: index + 1,
      selectedWork: result.selectedWork,
      outputPath: result.outputPath,
      exitReason: result.exitReason,
      decisionCount: Number(result.decisionCount) || 0,
      repliedCount: Number(result.repliedCount) || 0,
      sentUnconfirmedCount: Number(result.sentUnconfirmedCount) || 0,
      skippedCount: Number(result.skippedCount) || 0,
      errorCount: Number(result.errorCount) || 0
    }))
  };
}
