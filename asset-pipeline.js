'use strict';
/* asset-pipeline.js — speed work done once at startup on public/index.html (no build step, no new dependency):
   1. every local stylesheet in <head> is concatenated, in order, into one minified /bundle.css
      (one request instead of eleven render-blocking ones);
   2. the Google Fonts stylesheet stops blocking the first paint (media="print", switched to "all" by rays-bg.js);
   3. every local script/stylesheet/image URL in the page gets ?v=<content hash>, so those files can be cached for a
      year ("immutable") and still change the moment a new version is deployed (new content = new hash = new URL). */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const hash = buf => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);

// Conservative CSS minifier: comments and redundant whitespace only, nothing that changes meaning.
function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([{};,>])\s*/g, '$1')
    .replace(/\s*:\s*(?=[^{}]*;|[^{}]*})/g, ':')
    .replace(/;}/g, '}')
    .trim();
}

function localFile(publicDir, url) {
  const clean = url.split(/[?#]/)[0].replace(/^\.?\//, '');
  if (!clean || /^(https?:)?\/\//i.test(url) || clean.includes('..')) return null;
  const file = path.join(publicDir, clean);
  return file.startsWith(publicDir) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
}

function build(html, publicDir, extra) {
  extra = extra || {};   // { '/url': absolute file } for routes served from outside public/ (e.g. /odds-core.js)
  const head = html.slice(0, html.indexOf('</head>'));
  const linkRe = /<link rel="stylesheet" href="([^"]+)"[^>]*>\n?/g;
  const css = [];
  let firstAt = -1, m;
  while ((m = linkRe.exec(head))) {
    const file = localFile(publicDir, m[1]);
    if (!file) continue;
    if (firstAt < 0) firstAt = m.index;
    css.push({ tag: m[0], file });
  }
  let out = html, bundle = '';
  if (css.length) {
    // url(/x) in the CSS is site-absolute already; relative url()s would break when moved, so keep them pointing at the original folder
    bundle = css.map(c => {
      const dir = '/' + path.relative(publicDir, path.dirname(c.file)).split(path.sep).join('/');
      const src = fs.readFileSync(c.file, 'utf8').replace(/url\((['"]?)(?!data:|https?:|\/|#)([^'")]+)\1\)/g, (s, q, u) => `url(${q}${dir === '/' ? '' : dir}/${u}${q})`);
      return `/* ${path.basename(c.file)} */\n${src}`;
    }).join('\n');
    bundle = minifyCss(bundle);
    css.forEach((c, i) => { out = out.replace(c.tag, i === 0 ? '@@BUNDLE@@' : ''); });
    out = out.replace('@@BUNDLE@@', `<link rel="stylesheet" href="/bundle.css?v=${hash(bundle)}">\n`);
  }
  // Google Fonts: fetched without blocking render, applied when it arrives (rays-bg.js flips media to "all")
  out = out.replace(/<link rel="stylesheet" href="(https:\/\/fonts\.googleapis\.com\/[^"]+)">/, '<link rel="stylesheet" href="$1" media="print" data-async-css>');
  // fingerprint local scripts, images and remaining stylesheets
  out = out.replace(/(<(?:script|img)\b[^>]*?\ssrc=|<link\b[^>]*?\shref=)"([^"]+)"/g, (s, pre, url) => {
    if (url.startsWith('/bundle.css')) return s;
    const file = extra[url.split('?')[0]] || localFile(publicDir, url);
    if (!file) return s;
    const v = hash(fs.readFileSync(file));
    const base = url.split('?')[0];
    return `${pre}"${base}?v=${v}"`;
  });
  return { html: out, bundle };
}

module.exports = { build, minifyCss };
