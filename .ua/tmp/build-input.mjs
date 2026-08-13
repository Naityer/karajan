import fs from 'node:fs';
const scan = JSON.parse(fs.readFileSync('C:/Users/tiand/Desktop/Workspace/karajan/.ua/tmp/ua-scan-files.json', 'utf8'));
const out = {
  projectRoot: 'C:/Users/tiand/Desktop/Workspace/karajan',
  files: scan.files.map(f => ({ path: f.path, language: f.language, fileCategory: f.fileCategory })),
};
fs.writeFileSync('C:/Users/tiand/Desktop/Workspace/karajan/.ua/tmp/ua-import-map-input.json', JSON.stringify(out));
console.log('input files:', out.files.length);
