/* global Buffer, TextDecoder, TextEncoder, URL, clearInterval, clearTimeout, process, setImmediate, setInterval, setTimeout */
/**
 * webpack-shim.mjs - a tiny webpack runtime that executes module functions
 * captured from the cursor-agent bundle under plain Node.
 *
 * Usage:
 *   import { load } from "./webpack-shim.mjs";
 *   const agentPb = load("../proto/dist/generated/agent/v1/agent_pb.js");
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const nodeRequire = createRequire(import.meta.url);

export function captureBundle(bundleDir) {
  // --- main bundle: capture __webpack_modules__ without running the entry ---
  let src = fs.readFileSync(path.join(bundleDir, 'index.js'), 'utf8');
  if (!src.includes('var __webpack_modules__=')) throw new Error('unexpected main bundle shape');
  src = src.replace('var __webpack_modules__=', 'var __webpack_modules__=globalThis.__wbmod__=');
  src = src.replace('__webpack_require__("./src/main.tsx")', '0');
  const abs = path.join(bundleDir, 'index.js');
  const ctx = {
    console: { log() {}, error() {}, warn() {} },
    process,
    require: nodeRequire,
    module: { exports: {} },
    exports: {},
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    Buffer,
    URL,
    TextEncoder,
    TextDecoder,
    pathToFileURL,
    __non_webpack_require__: nodeRequire,
    __filename: abs,
    __dirname: bundleDir,
  };
  ctx.globalThis = ctx;
  ctx.global = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const registry = {};
  for (const [k, v] of Object.entries(ctx.__wbmod__)) registry[k] = v;

  // --- lazy chunks: NNNN.index.js are plain CJS payloads ---
  const chunkIndex = new Map(); // key -> chunk file it also appears in
  const files = fs
    .readdirSync(bundleDir)
    .filter((f) => /^\d+\.index\.js$/.test(f))
    .sort((a, b) => parseInt(a) - parseInt(b));
  for (const f of files) {
    const mod = nodeRequire(path.join(bundleDir, f));
    if (mod?.modules) {
      for (const [k, v] of Object.entries(mod.modules)) {
        if (!(k in registry)) {
          registry[k] = v;
          chunkIndex.set(k, f);
        }
      }
    }
  }
  return { registry, chunkIndex };
}

function posixDirname(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '.' : p.slice(0, i) || '/';
}
function posixNormalize(p) {
  const out = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

export function makeLoader(bundleDir) {
  const { registry, chunkIndex } = captureBundle(bundleDir);
  const cache = new Map();

  function resolveKey(fromKey, spec) {
    // node builtins pass through (only reachable via ctx.require, not here)
    const joined = posixNormalize(posixDirname(fromKey) + '/' + spec);
    if (joined in registry) return joined;
    // tail match: registry keys for pnpm deps live at a different tree depth
    // than the relative spec can reach; strip leading ../ and suffix-match.
    const tail = spec.replace(/^(\.\.\/)+/, '');
    const hits = Object.keys(registry).filter((k) => k.endsWith(tail));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      // prefer the shortest (most generic) - both are the same package copy
      return hits.sort((a, b) => a.length - b.length)[0];
    }
    throw new Error(`cannot resolve "${spec}" from ${fromKey} (joined=${joined})`);
  }

  function webpackRequire(key, fromKey) {
    const resolved = fromKey ? resolveKey(fromKey, key) : key;
    if (cache.has(resolved)) return cache.get(resolved).exports;
    const fn = registry[resolved];
    if (!fn) throw new Error(`module not in bundle: ${resolved}`);
    const module = { exports: {} };
    cache.set(resolved, module);
    fn.call(module.exports, module, module.exports, makeRequireFor(resolved));
    return module.exports;
  }

  function makeRequireFor(fromKey) {
    const req = (spec) => webpackRequire(spec, fromKey);
    // webpack runtime helpers used by the generated modules
    req.d = (exports, definition) => {
      for (const key of Object.keys(definition)) {
        if (!Object.prototype.hasOwnProperty.call(exports, key) || exports[key] === undefined) {
          Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
        }
      }
    };
    req.o = (obj, prop) => Object.prototype.hasOwnProperty.call(obj, prop);
    req.r = (exports) => {
      if (typeof Symbol !== 'undefined' && Symbol.toStringTag) {
        Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
      }
      Object.defineProperty(exports, '__esModule', { value: true });
    };
    req.n = (m) => {
      const getter = m && m.__esModule ? () => m.default : () => m;
      req.d({ g: getter }, { g: getter }); // noop-ish; mimics define getter usage
      return getter;
    };
    req.e = () =>
      Promise.reject(new Error('chunk loading not supported by shim (module missing from bundle)'));
    return req;
  }

  return {
    load: (key) => webpackRequire(key, null),
    has: (key) => key in registry,
    keys: () => Object.keys(registry),
    chunkIndex,
  };
}
