const http = require('http');
const fs = require('fs');
const path = require('path');
const port = process.env.PORT || 8090;
const mime = { '.gz': 'application/gzip', '.zip': 'application/zip', '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
http.createServer((req, res) => {
  const base = req.url.slice(1).replace(/%20/g, ' ');
  const file = path.join(__dirname, base || 'physique-os-saas.zip');
  if (!fs.existsSync(file)) return res.writeHead(404).end('Not found');
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${path.basename(file)}"` });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log('Serving on http://127.0.0.1:' + port));