import {copyFile} from 'node:fs/promises';
import path from 'node:path';
import {build} from 'vite';
import {exportStaticSite} from './export-static-site.mjs';

const project = path.resolve(import.meta.dirname, '..');
const distribution = path.join(project, 'dist');
const commit = process.env.VERCEL_GIT_COMMIT_SHA ?? '';
const ref = /^[a-f0-9]{40}$/i.test(commit) ? commit : 'main';
const audioBase = process.env.TEYVAT_AUDIO_BASE
  ?? `https://raw.githubusercontent.com/zaodonganqi/music-map/${ref}/dist/region-bgm-audio/`;

await build({root: project, build: {copyPublicDir: false}});
await copyFile(path.join(project, 'public/favicon.svg'), path.join(distribution, 'favicon.svg'));
const site = await exportStaticSite({
  source: distribution,
  output: process.env.TEYVAT_SITE_OUTPUT,
  audioBase,
});
console.log(`已生成 Vercel 静态站点 ${site.files} 个文件，共 ${(site.bytes / 1e6).toFixed(1)} MB`);
