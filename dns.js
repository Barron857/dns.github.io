const http = require('http');
const dnsPacket = require('dns-packet');
const dgram = require('dgram');

// 上游DNS服务器配置
const UPSTREAM_DNS_SERVERS = [
  { address: '8.8.8.8', port: 53, weight: 1, avgResponseTime: 0 },
  { address: '8.8.4.4', port: 53, weight: 1, avgResponseTime: 0 },
  { address: '1.1.1.1', port: 53, weight: 1, avgResponseTime: 0 }
];

// DNS查询缓存
const dnsCache = new Map();
const CACHE_TTL = 300000; // 缓存时间: 5分钟

// 创建HTTP服务器
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/dns-query') {
    let body = [];
    req.on('data', chunk => body.push(chunk)).on('end', () => {
      const dnsQuery = Buffer.concat(body);
      // 尝试从缓存获取响应
      const cacheKey = dnsQuery.toString('base64');
      const cachedResponse = dnsCache.get(cacheKey);

      if (cachedResponse && cachedResponse.expires > Date.now()) {
        res.writeHead(200, { 'Content-Type': 'application/dns-message' });
        res.end(cachedResponse.response);
        return;
      }

      // 缓存无效或不存在，向上游服务器查询
      forwardDnsQuery(dnsQuery, res).then(response => {
        if (response) {
          dnsCache.set(cacheKey, {
            response: response,
            expires: Date.now() + CACHE_TTL
          });
        }
      }).catch(error => {
        res.statusCode = 500;
        res.end(error.message);
      });
    });
  } else {
    res.statusCode = 404;
    res.end();
  }
});

// 转发DNS查询到上游DNS服务器
async function forwardDnsQuery(query, res) {
  return new Promise((resolve, reject) => {
    const server = selectUpstreamServer();
    const socket = dgram.createSocket('udp4');
    let resolved = false;

    socket.send(query, 0, query.length, server.port, server.address, err => {
      if (err) {
        reject(err);
        socket.close();
      }
    });

    socket.on('message', msg => {
      if (!resolved) {
        resolved = true;
        res.writeHead(200, { 'Content-Type': 'application/dns-message' });
        res.end(msg);
        resolve(msg);
        socket.close();
      }
    });

    socket.on('error', err => {
      if (!resolved) {
        reject(err);
        resolved = true;
        socket.close();
      }
    });

    socket.setTimeout(5000, () => {
      if (!resolved) {
        reject(new Error('Timeout'));
        resolved = true;
        socket.close();
      }
    });
  });
}

// 选择上游服务器
function selectUpstreamServer() {
  let totalWeight = UPSTREAM_DNS_SERVERS.reduce((sum, { weight }) => sum + weight, 0);
  let choice = Math.random() * totalWeight;
  for (let server of UPSTREAM_DNS_SERVERS) {
    if ((choice -= server.weight) <= 0) {
      return server;
    }
  }
  return UPSTREAM_DNS_SERVERS[0];
}

// 监听端口，接收HTTP流量
const PORT = 8787;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});