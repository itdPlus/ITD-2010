const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const config = require('./config');

const TOKEN = config.REFRESH_TOKEN;
const PORT = config.PORT || 3000;
const API = 'https://xn--d1ah4a.com';
const DIR = path.resolve(__dirname);

let accessToken = null;

const MIME = {
    '.html': 'text/html;charset=utf-8',
    '.js':   'application/javascript;charset=utf-8',
    '.css':  'text/css;charset=utf-8',
    '.ico':  'image/x-icon',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.gif':  'image/gif',
    '.svg':  'image/svg+xml',
    '.json': 'application/json;charset=utf-8',
    '.woff2': 'font/woff2',
    '.woff':  'font/woff',
    '.ttf':   'font/ttf',
};

function readBody(req) {
    return new Promise(resolve => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

async function refreshToken() {
    return new Promise(resolve => {
        const req = https.request({
            hostname: new URL(API).hostname,
            port: 443,
            path: '/api/v1/auth/refresh',
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'cookie': `refresh_token=${TOKEN}`,
                'origin': API,
                'user-agent': 'Mozilla/5.0',
            },
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    console.error(`токен не обновился (${res.statusCode}) — refresh_token устарел`);
                    return resolve(null);
                }
                try {
                    const { accessToken: token } = JSON.parse(Buffer.concat(chunks).toString());
                    const { exp } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
                    accessToken = token;

                    const msLeft = exp * 1000 - Date.now() - 30_000;
                    if (msLeft > 0) setTimeout(refreshToken, msLeft);

                    console.log(`токен обновлён, действует до ${new Date(exp * 1000).toLocaleTimeString()}`);
                    resolve(token);
                } catch {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.end();
    });
}

function sendProxy(req, res, body, headers) {
    const target = new URL(req.url, API);

    const outHeaders = {
        ...headers,
        host: target.hostname,
        origin: API,
        cookie: `refresh_token=${TOKEN}`,
        'user-agent': 'Mozilla/5.0',
        authorization: `Bearer ${accessToken}`,
    };
    delete outHeaders['if-none-match'];
    delete outHeaders['if-modified-since'];

    const options = {
        hostname: target.hostname,
        port: 443,
        path: target.pathname + target.search,
        method: req.method,
        headers: outHeaders,
    };

    const proxyReq = https.request(options, async proxyRes => {
        if (proxyRes.statusCode === 401) {
            proxyRes.resume();
            const newToken = await refreshToken();
            if (!newToken) {
                res.writeHead(401, { 'content-type': 'application/json' });
                return res.end(JSON.stringify({ error: 'unauthorized' }));
            }
            outHeaders.authorization = `Bearer ${newToken}`;
            const retry = https.request({ ...options, headers: outHeaders }, retryRes => {
                res.writeHead(retryRes.statusCode, {
                    ...retryRes.headers,
                    'access-control-allow-origin': '*',
                });
                retryRes.pipe(res);
            });
            retry.on('error', e => { res.writeHead(502); res.end(e.message); });
            if (body.length) retry.write(body);
            return retry.end();
        }

        res.writeHead(proxyRes.statusCode, {
            ...proxyRes.headers,
            'access-control-allow-origin': '*',
        });
        proxyRes.pipe(res);
    });

    proxyReq.on('error', e => {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
    });

    if (body.length) proxyReq.write(body);
    proxyReq.end();
}

async function handleApi(req, res) {
    const urlPath = new URL(req.url, 'http://localhost').pathname;
    const body = await readBody(req);

    if (urlPath === '/api/v1/auth/refresh' && req.method === 'POST') {
        const token = accessToken || await refreshToken();
        if (!token) {
            res.writeHead(401, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: 'refresh failed' }));
        }
        res.writeHead(200, {
            'content-type': 'application/json',
            'set-cookie': 'is_auth=1; Path=/; SameSite=Lax',
        });
        return res.end(JSON.stringify({ accessToken: token }));
    }

    if (!accessToken) await refreshToken();
    sendProxy(req, res, body, req.headers);
}

function serveStatic(req, res) {
    const urlPath = new URL(req.url, 'http://localhost').pathname;
    let filePath = path.join(DIR, urlPath);

    if (!path.extname(filePath)) {
        const html = filePath + '.html';
        filePath = fs.existsSync(html) ? html : path.join(DIR, 'index.html');
    }

    const authCookie = 'is_auth=1; Path=/; SameSite=Lax';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            fs.readFile(path.join(DIR, 'index.html'), (err2, data2) => {
                if (err2) { res.writeHead(404); return res.end('not found'); }
                res.writeHead(200, { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store', 'set-cookie': authCookie });
                res.end(data2);
            });
            return;
        }
        const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
        const extra = mime.includes('text/html') ? { 'set-cookie': authCookie } : {};
        res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store', ...extra });
        res.end(data);
    });
}

const server = http.createServer(async (req, res) => {
    const urlPath = new URL(req.url, 'http://localhost').pathname;

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
            'access-control-allow-headers': 'Content-Type,Authorization',
        });
        return res.end();
    }

    if (urlPath.startsWith('/api')) return handleApi(req, res);

    if (urlPath.startsWith('/assets/') && !fs.existsSync(path.join(DIR, urlPath))) {
        const body = await readBody(req);
        return sendProxy(req, res, body, req.headers);
    }

    serveStatic(req, res);
});

server.listen(PORT, async () => {
    if (!TOKEN || TOKEN === 'ВСТАВЬ_СЮДА') {
        console.log('укажи refresh_token в config.js');
        return;
    }
    await refreshToken();
    console.log(`http://localhost:${PORT}`);
});