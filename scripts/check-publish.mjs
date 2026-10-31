/**
 * 发布前自检：包名占位、必需文件、dist 产物
 * 由 prepublishOnly 调用，失败即阻止发布
 */
import fs from 'node:fs';

const errors = [];
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

if (!pkg.name || pkg.name.includes('@scope/')) {
  errors.push(`package.json name 仍是占位值：${pkg.name}`);
}
for (const file of ['dist/index.js', 'dist/cli.js', 'dist/index.d.ts', 'README.md', 'LICENSE']) {
  if (!fs.existsSync(new URL(`../${file}`, import.meta.url))) errors.push(`缺少文件：${file}`);
}
if (!pkg.publishConfig || pkg.publishConfig.access !== 'public') {
  errors.push('publishConfig.access 必须为 public');
}
if (pkg.private === true) {
  errors.push('package.json 不能是 private');
}

if (errors.length > 0) {
  console.error('发布前自检未通过：');
  for (const err of errors) console.error(` - ${err}`);
  process.exit(1);
}
console.log(`发布前自检通过：${pkg.name}@${pkg.version}`);
