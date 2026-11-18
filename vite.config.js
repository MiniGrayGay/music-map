import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';
import vue from '@vitejs/plugin-vue';
import {parseByteRange} from './scripts/byte-range.mjs';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(projectDir, '..', '..');
const tilesDir = path.join(projectDir, 'dist', 'tiles');
const reliefDir = path.join(projectDir, 'dist', 'relief');
const layersDir = path.join(projectDir, 'dist', 'layers');
const workspaceAudio = path.join(workspaceRoot, 'dist', 'region-bgm-audio');
const audioDir = fs.existsSync(workspaceAudio) ? workspaceAudio : path.join(projectDir, 'dist/region-bgm-audio');
const workspaceBgm = path.join(workspaceRoot, 'dist', 'genshin-region-bgm.json');
const projectBgm = path.join(projectDir, 'dist', 'data', 'genshin-region-bgm.json');

function serveTilesDev(server) {
  server.middlewares.use((req, res, next) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' || !url.pathname.startsWith('/tiles/')) {
      next();
      return;
    }
    const name = url.pathname.slice('/tiles/'.length);
    const meta = name === 'meta.json';
    if (!meta && !/^[A-Za-z]+\/\d+\/\d+\/\d+\.webp$/.test(name)) {
      res.statusCode = 404;
      return res.end();
    }
    const file = path.join(tilesDir, name);
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.statusCode = 404;
        res.end('tile missing; run pnpm run tiles');
        return;
      }
      res.setHeader('Content-Type', meta ? 'application/json; charset=utf-8' : 'image/webp');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Cache-Control', meta ? 'no-cache' : 'public, max-age=31536000, immutable');
      fs.createReadStream(file).pipe(res);
    });
  });
}

function serveMusicData(server) {
  server.middlewares.use((req, res, next) => {
    const url = new URL(req.url, 'http://localhost');
    const isBgm = url.pathname === '/data/genshin-region-bgm.json';
    const source = isBgm ? (fs.existsSync(projectBgm) ? projectBgm : workspaceBgm)
      : url.pathname === '/data/map-data.json' ? path.join(projectDir, 'public/data/map-data.json') : null;
    if (req.method !== 'GET' || !source) {
      next();
      return;
    }
    const file = fs.existsSync(source) ? source : path.join(projectDir, 'dist', url.pathname.slice(1));
    if (fs.existsSync(file)) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      fs.createReadStream(file).pipe(res);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
}

function serveLayersDev(server) {
  server.middlewares.use((req, res, next) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' || !url.pathname.startsWith('/layers/')) return next();
    const name = url.pathname.slice('/layers/'.length);
    const manifest = name === 'manifest.json' || name === 'basemaps.json';
    const texture = /^[A-Za-z]+\/UI_Map_LayeredMap_\d+\.webp$/.test(name);
    const baseTile = /^base\/[A-Za-z]+\/r-?\d+c-?\d+\.webp$/.test(name);
    if (!manifest && !texture && !baseTile) {
      res.statusCode = 404;
      return res.end();
    }
    const file = path.join(layersDir, name);
    fs.stat(file, (error, stat) => {
      if (error || !stat.isFile()) {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader('Content-Type', manifest ? 'application/json; charset=utf-8' : 'image/webp');
      res.setHeader('Content-Length', stat.size);
      fs.createReadStream(file).pipe(res);
    });
  });
}

function serveReliefDev(server) {
  server.middlewares.use((req, res, next) => {
    const url = new URL(req.url, 'http://localhost');
    const match = url.pathname.match(/^\/relief\/(index\.json|points-[a-f0-9]{16}\.f32)$/);
    if (req.method !== 'GET' || !match) return next();
    const [, name] = match;
    const file = path.join(reliefDir, name);
    fs.stat(file, (error, stat) => {
      if (error || !stat.isFile()) { res.statusCode = 404; res.end(); return; }
      const metadata = name === 'index.json';
      const range = metadata ? null : parseByteRange(req.headers.range, stat.size);
      res.setHeader('Cache-Control', metadata ? 'no-cache' : 'public, max-age=31536000, immutable');
      res.setHeader('Content-Type', metadata ? 'application/json; charset=utf-8' : 'application/octet-stream');
      if (range?.unsatisfiable) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        res.end();
        return;
      }
      const {start, end} = range ?? {start: 0, end: stat.size - 1};
      if (range) {
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      }
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Length', end - start + 1);
      const stream = fs.createReadStream(file, {start, end});
      res.on('close', () => stream.destroy());
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    });
  });
}

function serveAudio(server) {
  server.middlewares.use((req, res, next) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const match = pathname.match(/^\/region-bgm-audio\/(\d+\.opus)$/);
    if (!match || !['GET', 'HEAD'].includes(req.method)) return next();
    const file = path.join(audioDir, match[1]);
    fs.stat(file, (error, stat) => {
      if (error || !stat.isFile()) {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader('Content-Type', 'audio/ogg; codecs=opus');
      res.setHeader('Accept-Ranges', 'bytes');
      const range = req.method === 'GET' ? parseByteRange(req.headers.range, stat.size) : null;
      if (range?.unsatisfiable) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        return res.end();
      }
      const {start, end} = range ?? {start: 0, end: stat.size - 1};
      if (range) {
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      }
      res.setHeader('Content-Length', end - start + 1);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file, {start, end}).pipe(res);
    });
  });
}

const buildManifestPath = 'data/build-assets.json';

// Vite's manifest only records assets with a rollup `name`; the `vite:worker`
// plugin emits worker chunks with an explicit fileName and no name, so entries
// like `assets/tileMipWorker-*.js` never reach data/build-assets.json and the
// static export script omits them. Backfill those emitted assets here.
function includeWorkerAssetsInManifest() {
  return {
    name: 'teyvat-manifest-backfill-unnamed-assets',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const manifestEntry = bundle[buildManifestPath];
        if (!manifestEntry || manifestEntry.type !== 'asset') return;
        const manifest = JSON.parse(typeof manifestEntry.source === 'string'
          ? manifestEntry.source
          : Buffer.from(manifestEntry.source).toString('utf8'));
        const listedFiles = new Set(Object.values(manifest).map((entry) => entry.file).filter(Boolean));
        for (const asset of Object.values(bundle)) {
          if (asset.type !== 'asset' || !/^assets\/[A-Za-z0-9_-]+\.js$/.test(asset.fileName)) continue;
          if (listedFiles.has(asset.fileName)) continue;
          manifest[`_${asset.fileName}`] = {file: asset.fileName};
        }
        manifestEntry.source = JSON.stringify(manifest, null, 2);
      },
    },
  };
}

export default defineConfig({
  base: './',
  esbuild: {jsx: 'automatic'},
  plugins: [
    vue(),
    {
      name: 'teyvat-readonly-dev-assets',
      configureServer(server) {
        serveTilesDev(server);
        serveLayersDev(server);
        serveReliefDev(server);
        serveMusicData(server);
        serveAudio(server);
      },
    },
    includeWorkerAssetsInManifest(),
  ],
  build: {emptyOutDir: false, manifest: buildManifestPath},
  server: {host: '127.0.0.1', port: 5177, strictPort: true},
  preview: {host: '127.0.0.1', port: 5177, strictPort: true},
});
