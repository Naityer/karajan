import fs from 'node:fs';
const scan = JSON.parse(fs.readFileSync('C:/Users/tiand/Desktop/Workspace/karajan/.ua/tmp/ua-scan-files.json', 'utf8'));
const imp = JSON.parse(fs.readFileSync('C:/Users/tiand/Desktop/Workspace/karajan/.ua/tmp/ua-import-map-output.json', 'utf8'));

const description = "KARAJAN is a local-first AI task-routing harness: it classifies a free-form prompt by domain, intent, risk, and complexity, computes a weighted complexity score, recommends a model strategy, prepares or simulates delegated subtasks, and persists the full audit trail in SQLite behind a FastAPI backend and a dense web console. It withholds delegation with an explicit reason when no local provider (Ollama, Claude Code, Codex) is ready rather than faking an execution. Note: this project has over 100 source files; consider scoping analysis to a subdirectory for faster results.";

const languages = Object.keys(scan.stats.byLanguage).sort((a, b) => a.localeCompare(b));

const frameworks = ["FastAPI", "Pydantic", "Uvicorn", "pytest"];

const result = {
  name: "karajan",
  description,
  languages,
  frameworks,
  files: scan.files,
  totalFiles: scan.totalFiles,
  filteredByIgnore: scan.filteredByIgnore,
  estimatedComplexity: scan.estimatedComplexity,
  importMap: imp.importMap,
};

fs.mkdirSync('C:/Users/tiand/Desktop/Workspace/karajan/.ua/intermediate', { recursive: true });
fs.writeFileSync('C:/Users/tiand/Desktop/Workspace/karajan/.ua/intermediate/scan-result.json', JSON.stringify(result, null, 2));
console.log('totalFiles', result.totalFiles, 'files.length', result.files.length, 'importMap keys', Object.keys(result.importMap).length, 'languages', languages.length);
