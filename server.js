const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

const server = http.createServer(function (req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch (e) {
    res.writeHead(400);
    return res.end('bad request');
  }
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('ok');
  }
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('forbidden');
  }

  fs.readFile(filePath, function (err, data) {
    if (err) {
      fs.readFile(path.join(ROOT, 'index.html'), function (err2, index) {
        if (err2) {
          res.writeHead(404);
          return res.end('not found');
        }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(index);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    });
    res.end(data);
  });
});

server.listen(PORT, function () {
  console.log('[hokm] serving on port ' + PORT + (process.env.NODE_ENV ? ' (' + process.env.NODE_ENV + ')' : ''));
});
