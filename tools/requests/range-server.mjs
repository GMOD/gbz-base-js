// Static file server with HTTP Range support, for cold-cache request counts
// against local copies. Usage: node range-server.mjs <dir> <port>
import { createServer } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { join, normalize } from 'node:path'

const [dir, port] = process.argv.slice(2)
let served = 0
createServer((req, res) => {
  const file = join(dir, normalize(decodeURIComponent(req.url.split('?')[0])))
  let size
  try {
    size = statSync(file).size
  } catch {
    res.writeHead(404).end()
    return
  }
  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Type', 'application/octet-stream')
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Length': size }).end()
    return
  }
  if (!range) {
    res.writeHead(200, { 'Content-Length': size })
    createReadStream(file).pipe(res)
    return
  }
  const start = Number(range[1])
  const end = Math.min(range[2] === '' ? size - 1 : Number(range[2]), size - 1)
  served += 1
  res.writeHead(206, {
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${size}`,
  })
  createReadStream(file, { start, end }).pipe(res)
}).listen(Number(port), () => console.log(`serving ${dir} on ${port}`))
