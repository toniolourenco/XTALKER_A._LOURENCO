// stalkerengine.cjs – Motor centralizado para portais Stalker
const axios = require("axios");
const crypto = require("crypto");
const https = require('https');
const { PassThrough } = require('stream');
const { spawn } = require('child_process');

// Cache de autenticação (10 minutos)
const authCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

// ============================================================
// 1. AUTENTICAÇÃO (copiada do addon.cjs, com suporte a proxy)
// ============================================================
async function authenticate(config, proxyUrl = null) {
    const mac = (config.mac || "00:1A:79:00:00:00").toUpperCase();
    const cleanBase = config.url.trim().replace(/\/$/, "");
    const cacheKey = `auth_${cleanBase}_${mac}`;

    if (authCache.has(cacheKey)) {
        const cached = authCache.get(cacheKey);
        if (Date.now() - cached.timestamp < CACHE_TTL) return cached.data;
    }

    const fakeResidencialIP = '188.81.121.45';
    const deviceId = crypto.createHash('md5').update(mac).digest('hex').toUpperCase();
    const shortHash = crypto.createHash('md5').update(mac).digest('hex').substring(0, 13).toUpperCase();
    const serialNumber = `8CA3${shortHash.substring(4)}`;

    const universalHeaders = {
        'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
        'X-User-Agent': `Model: MAG250; SW: 2.18-r14-pub-250; STB_active: true; Device ID: ${deviceId}; Device ID 2: ${deviceId}; Signature: 88e76854; SN: ${serialNumber}`,
        'Referer': `${cleanBase}/c/`,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Runtime-Info': 'render: gles; s_type: 250; s_ver: 0.2.18-r14;',
        'X-Requested-With': 'XMLHttpRequest',
        'X-Forwarded-For': fakeResidencialIP,
        'X-Real-IP': fakeResidencialIP,
        'Client-IP': fakeResidencialIP,
        'Cookie': `mac=${encodeURIComponent(mac)}; stb_lang=en; timezone=Europe/Lisbon;`
    };

    const paths = ['/c/portal.php', '/portal.php', '/server/load.php', '/stalker_portal/server/load.php'];

    console.log(`[STB-EMU MODE] Tentando enganar portal: ${cleanBase}`);

    for (const path of paths) {
        const fullUrl = `${cleanBase}${path}?`;
        try {
            const handshakeUrl = `${fullUrl}type=stb&action=handshake&mac=${encodeURIComponent(mac)}&JsHttpRequest=1-0`;
            const res = await axios.get(handshakeUrl, getAxiosOpts(config, { headers: universalHeaders, timeout: 5000 }, proxyUrl));
            let data = res.data;
            if (typeof data === 'string') data = JSON.parse(data.replace(/\/\*[\s\S]*?\*\//g, "").trim());
            if (data?.js?.token) {
                const token = data.js.token;
                console.log(`[AUTH SUCCESS] Servidor enganado em: ${path}`);
                universalHeaders.Authorization = `Bearer ${token}`;
                universalHeaders.Cookie += ` token=${token}; access_token=${token};`;
                try { await axios.get(`${fullUrl}type=stb&action=get_profile&token=${token}&JsHttpRequest=1-0`, getAxiosOpts(config, { headers: universalHeaders })); } catch (e) { }
                const result = {
                    api: fullUrl,
                    apiAlt: fullUrl.replace(/\/[^\/]+$/, '/server/load.php?'),
                    token,
                    authData: { sn: data.js.sn || deviceId.substring(0, 13), headers: universalHeaders }
                };
                authCache.set(cacheKey, { data: result, timestamp: Date.now() });
                return result;
            }
        } catch (e) {
            console.warn(`[AUTH SCAN] ${path} recusado (Status: ${e.response?.status || 'OFFLINE'})`);
        }
    }

// Fallback clássico (método antigo, sem IP falso)
console.log(`[AUTH] Caminhos modernos falharam. A tentar método clássico...`);
const classicBase = cleanBase.replace(/\/c$/, '');
const classicPaths = ['/c/portal.php', '/stalker_portal/c/portal.php', '/portal.php', '/server/load.php'];

for (const path of classicPaths) {
    const fullUrl = `${classicBase}${path}?`;
    try {
        const handshakeUrl = `${fullUrl}type=stb&action=handshake&mac=${encodeURIComponent(mac)}&JsHttpRequest=1-0`;
        const classicHeaders = {
    'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
    'Referer': `${classicBase}/c/`,
    'Accept': '*/*',
    'Connection': 'keep-alive',
    'Cookie': `mac=${encodeURIComponent(mac)}; stb_lang=en; timezone=Europe/Lisbon;`
};
        const res = await axios.get(handshakeUrl, getAxiosOpts(config, { headers: classicHeaders, timeout: 8000 }, proxyUrl));
        let data = res.data;
        if (typeof data === 'string') data = JSON.parse(data.replace(/\/\*[\s\S]*?\*\//g, "").trim());
        if (data?.js?.token) {
            const token = data.js.token;
            console.log(`[AUTH SUCCESS] Clássico funcionou em: ${path}`);
            classicHeaders.Authorization = `Bearer ${token}`;
            classicHeaders.Cookie += ` token=${token}; access_token=${token};`;
            const result = {
                api: `${classicBase}${path}?`,
                apiAlt: `${classicBase}/server/load.php?`,
                token,
                authData: { sn: data.js.sn || classicHeaders.sn, headers: classicHeaders }
            };
            authCache.set(cacheKey, { data: result, timestamp: Date.now() });
            return result;
        }
    } catch (e) {
        console.warn(`[AUTH SCAN] Clássico recusado em ${path} (${e.message})`);
    }
}
    console.error(`[AUTH FATAL] Nenhum caminho ou perfil funcionou para este MAC.`);
    return null;
}

// ============================================================
// 2. CRIAÇÃO DE LINK (create_link unificado)
// ============================================================
async function createStreamLink(auth, config, stalkerCmd, type, sNum = null) {
    const cmdType = (type === "movie" || type === "series") ? "vod" : "itv";
    const seriesParam = sNum ? `&series=${sNum}` : '';
    const chCheck = type === "tv" ? "&force_ch_link_check=1" : "";
    const realCmd = stalkerCmd;

    const opts = getAxiosOpts(config, { headers: auth.authData.headers, timeout: 5000 }, config.proxy);

    // Tentativa 1: comando original (cmd)
    let linkUrl = `${auth.api}type=${cmdType}&action=create_link&cmd=${encodeURIComponent(realCmd)}${seriesParam}&sn=${auth.authData.sn}&token=${auth.token}${chCheck}&long_lived=1&JsHttpRequest=1-0`;
    let res = await axios.get(linkUrl, opts).catch(() => ({}));
    let url = extractUrl(res.data?.js);

    // Tentativa 2: video_id
    if (!url) {
        linkUrl = `${auth.api}type=${cmdType}&action=create_link&video_id=${encodeURIComponent(realCmd)}${seriesParam}&sn=${auth.authData.sn}&token=${auth.token}${chCheck}&long_lived=1&JsHttpRequest=1-0`;
        res = await axios.get(linkUrl, opts).catch(() => ({}));
        url = extractUrl(res.data?.js);
    }

    // Tentativa 3: para séries
    if (!url && type === "series") {
        linkUrl = `${auth.api}type=series&action=create_link&video_id=${encodeURIComponent(realCmd)}${seriesParam}&sn=${auth.authData.sn}&token=${auth.token}${chCheck}&long_lived=1&JsHttpRequest=1-0`;
        res = await axios.get(linkUrl, opts).catch(() => ({}));
        url = extractUrl(res.data?.js);
    }

    // Tentativa 4: movie_id (para filmes e séries)
    if (!url && (type === "series" || type === "movie")) {
        linkUrl = `${auth.api}type=vod&action=create_link&movie_id=${encodeURIComponent(realCmd)}${seriesParam}&sn=${auth.authData.sn}&token=${auth.token}${chCheck}&long_lived=1&JsHttpRequest=1-0`;
        res = await axios.get(linkUrl, opts).catch(() => ({}));
        url = extractUrl(res.data?.js);
    }

    return url;
}

function extractUrl(jsData) {
    if (!jsData) return null;
    let url = jsData?.cmd || jsData?.url || (typeof jsData === 'string' ? jsData : null);
    if (!url && typeof jsData === 'object') {
        url = Object.values(jsData).find(v => typeof v === 'string' && (v.startsWith('http') || v.includes('://')));
    }
    return url ? url.trim().replace(/^(ffrt|ffmpeg|ffrt2|rtmp)\s+/i, "") : null;
}

// ============================================================
// 3. RELAY FFMPEG (unificado, com proxy)
// ============================================================
function startFfmpegRelay(urlToPlay, headersObj, proxyUrl = null, legacyMode = false, onCloseCallback = null) {
    const headersStr = Object.entries(headersObj)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n') + '\r\n\r\n';

    const ffmpegArgs = [
    '-headers', headersStr,
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-fflags', 'nobuffer+discardcorrupt+genpts',
    '-err_detect', 'ignore_err',
    '-buffer_size', '1024k',
    '-max_delay', '500000',
    '-i', urlToPlay,
    '-c', 'copy',
    '-f', 'mpegts',
    '-loglevel', 'error',
    'pipe:1'
];

if (proxyUrl && proxyUrl.startsWith('http')) {
    ffmpegArgs.unshift('-http_proxy', proxyUrl);
    console.log(`[STALKER ENGINE] FFmpeg a usar proxy HTTP: ${proxyUrl}`);
}

if (legacyMode) {
    ffmpegArgs.splice(1, 0, '-re');
    console.log(`[STALKER ENGINE] Modo LEGACY ativado (-re).`);
}

const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    const source = ffmpeg.stdout;
    ffmpeg.on('error', (err) => {
        console.error(`[STALKER ENGINE] Erro no FFmpeg: ${err.message}`);
        if (onCloseCallback) onCloseCallback(1);
    });
    ffmpeg.on('close', (code) => {
        console.log(`[STALKER ENGINE] FFmpeg encerrado (código ${code}).`);
        if (onCloseCallback) onCloseCallback(code);
    });
    source.kill = () => { if (!ffmpeg.killed) ffmpeg.kill('SIGKILL'); };
    return source;
}

// ============================================================
// 4. FILLER (ecrã preto)
// ============================================================
function generateFiller(durationSec = 4) {
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
            '-f', 'lavfi',
            '-i', `color=c=black:s=320x240:d=${durationSec}`,
            '-f', 'mpegts',
            '-loglevel', 'error',
            'pipe:1'
        ]);
        resolve(ffmpeg.stdout);
        ffmpeg.on('error', reject);
    });
}

// ============================================================
// 5. GESTOR DE SESSÃO (broadcaster + clientes)
// ============================================================
class SessionManager {
    constructor() {
        this.activeStreams = {};
        this.pendingPromises = {};
        this.fillerAttempts = {};
        this.lastGoodUrl = {};
    }

    getSession(streamKey) {
        return this.activeStreams[streamKey] || null;
    }

    createSession(streamKey, res) {
        if (!this.activeStreams[streamKey]) {
            this.activeStreams[streamKey] = {
                broadcaster: new PassThrough({ highWaterMark: 1024 * 1024 * 5 }),
                clients: new Set(),
                source: null,
                timeout: null,
                renewTimer: null
            };
        }
        const cached = this.activeStreams[streamKey];
        cached.clients.add(res);
        return cached;
    }

    connectToExistingBroadcaster(cached, res, streamKey, req) {
        if (cached.broadcaster && !cached.broadcaster.destroyed) {
            console.log(`[PROXY TV] Reconexão rápida detetada.`);
            if (cached.timeout) { clearTimeout(cached.timeout); cached.timeout = null; }
            res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
            cached.broadcaster.pipe(res);
            cached.clients.add(res);
            req.on('close', () => {
                cached.clients.delete(res);
                cached.broadcaster.unpipe(res);
                if (cached.clients.size === 0) {
                    cached.timeout = setTimeout(() => {
                        if (cached.source && cached.source.kill) cached.source.kill();
                        if (cached.broadcaster) cached.broadcaster.destroy();
                        delete this.activeStreams[streamKey];
                        console.log(`[PROXY TV] Ligação libertada após inatividade.`);
                    }, 15000);
                }
            });
            return true;
        }
        return false;
    }
}

// ============================================================
// 6. FUNÇÕES AUXILIARES
// ============================================================
function getAxiosOpts(config, extraOpts = {}, proxyUrl = null) {
    let opts = { ...extraOpts };
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });
    opts.httpsAgent = httpsAgent;
    
    const proxyStr = proxyUrl || (config && config.proxy ? config.proxy.trim() : null);
    
    if (proxyStr) {
        if (proxyStr.startsWith('socks')) {
            const { SocksProxyAgent } = require('socks-proxy-agent');
            const agent = new SocksProxyAgent(proxyStr);
            agent.options.rejectUnauthorized = false;
            opts.httpAgent = agent;
            opts.httpsAgent = agent;
        } else if (proxyStr.startsWith('http')) {
            try {
                const p = new URL(proxyStr);
                opts.proxy = {
                    protocol: p.protocol.replace(':', ''),
                    host: p.hostname,
                    port: parseInt(p.port),
                    auth: p.username ? { username: decodeURIComponent(p.username), password: decodeURIComponent(p.password) } : undefined
                };
            } catch(e) {}
        }
    }
    return opts;
}

// ============================================================
// 7. DETEÇÃO AUTOMÁTICA DE PIPELINE (sem listas fixas)
// ============================================================
async function tryMultiplePipelines(cleanUrl, auth, config, type, res, sessions, streamKey, req) {
    let methods;
    if (cleanUrl.includes('play_token')) {
    console.log(`[AUTO-DETECT] play_token detetado. Prioridade: ffmpeg-exact (1º repo) > ffmpeg-legacy > ...`);
    methods = [
        { name: 'ffmpeg-exact', fn: tryFfmpegExact },   // réplica exata do 1º repositório
        { name: 'ffmpeg-legacy', fn: tryFfmpegStreamLegacy },
        { name: 'ffmpeg-modern', fn: tryFfmpegModernRelay },
        { name: 'legacy', fn: tryLegacyRelay },
        { name: 'modern', fn: tryModernRelay },
        { name: 'redirect', fn: tryRedirect }
     ];
    } else {
        methods = [
            { name: 'direct', fn: tryDirectAccess },
            { name: 'modern', fn: tryModernRelay },
            { name: 'legacy', fn: tryLegacyRelay },
            { name: 'redirect', fn: tryRedirect }
        ];
    }

    for (const method of methods) {
        console.log(`[AUTO-DETECT] A tentar método: ${method.name}`);
        try {
            const result = await method.fn(cleanUrl, auth, config, type, res, sessions, streamKey, req);
            if (result && result.success) {
                console.log(`[AUTO-DETECT] Sucesso com método: ${method.name}`);
                return result;
            }
        } catch (e) {
            console.warn(`[AUTO-DETECT] Método ${method.name} falhou: ${e.message}`);
        }
    }
    return { success: false, error: 'Todos os métodos falharam' };
}

async function tryDirectAccess(urlToPlay, auth, config, type, res, sessions, streamKey, req) {
    if (!urlToPlay.includes('/ch/')) return { success: false };
    const basePortal = config.url.split('/c/')[0];
    const directUrl = basePortal + urlToPlay.substring(urlToPlay.indexOf('/ch/'));
    try {
        const response = await axios.get(directUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
                'Referer': config.url + '/c/',
                'Connection': 'keep-alive'
            },
            responseType: 'stream',
            timeout: 3000,
            validateStatus: status => status === 200
        });
        return { success: true, source: response.data, method: 'direct' };
    } catch (e) {
        return { success: false };
    }
}

async function tryModernRelay(urlToPlay, auth, config, type, res, sessions, streamKey, req) {
    try {
        const streamHeaders = {
            ...auth.authData.headers,
            'Referer': config.url + '/c/',
            'Accept': '*/*',
            'Connection': 'keep-alive'
        };
        const axiosOpts = getAxiosOpts(config, {
            url: urlToPlay,
            headers: streamHeaders,
            responseType: 'stream',
            timeout: 5000
        });
        const streamRes = await axios(axiosOpts);
        return { success: true, source: streamRes.data, method: 'modern' };
    } catch (e) {
        return { success: false };
    }
}

async function tryLegacyRelay(urlToPlay, auth, config, type, res, sessions, streamKey, req) {
    try {
        const legacyHeaders = {
            'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
            'Cookie': auth.authData.headers['Cookie'] || '',
            'Referer': config.url + '/c/',
            'Connection': 'keep-alive'
        };
        const source = startFfmpegRelay(urlToPlay, legacyHeaders, config.proxy, true, null);
        return { success: true, source, method: 'legacy' };
    } catch (e) {
        return { success: false };
    }
}

async function tryRedirect(urlToPlay, auth, config, type, res, sessions, streamKey, req) {
    return { success: true, method: 'redirect', url: urlToPlay };
}

async function tryFfmpegModernRelay(urlToPlay, auth, config, type, res, sessions, streamKey, req) {
    try {
        const headersObj = {
            'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
            'Cookie': auth.authData.headers['Cookie'] || '',
            'Referer': config.url + '/c/',
            'Connection': 'keep-alive'
        };
        const source = startFfmpegRelay(urlToPlay, headersObj, config.proxy, false, null); // legacyMode = false
        return { success: true, source, method: 'ffmpeg-modern' };
    } catch (e) {
        return { success: false };
    }
}

async function tryFfmpegStreamLegacy(urlToPlay, auth, config, type, res, sessions, streamKey, req) {
    try {
        // Replica exatamente os headers que o 1º repositório enviava no doFfmpegStream
        const baseHeaders = auth.authData.headers || {};
        const ffmpegHeaders = {
            ...baseHeaders,                               // inclui Authorization, X-User-Agent, etc.
            'Cookie': baseHeaders['Cookie'] || '',       // garante que o cookie está presente
            'User-Agent': 'Mozilla/5.0 (Unknown; Linux armv7l) AppleWebKit/537.1+ (KHTML, like Gecko) Safari/537.1+ Stalker portal (0.5.66/0.5.66/1.0)',
            'Referer': config.url + '/c/',
            'Accept': '*/*',
            'Connection': 'keep-alive'
        };
        const source = startFfmpegRelay(urlToPlay, ffmpegHeaders, config.proxy, false, null);
        return { success: true, source, method: 'ffmpeg-legacy' };
    } catch (e) {
        return { success: false };
    }
}

async function tryFfmpegExact(urlToPlay, auth, config, type, res, sessions, streamKey, req) {
    try {
        // EXATAMENTE o mesmo código do doFfmpegStream do 1º repositório
        const rawHeaders = auth.authData.headers || {};
        const cookieString = rawHeaders['Cookie'] || '';
        const ffmpegHeaders = Object.entries({
            ...rawHeaders,
            'Cookie': cookieString,
            'User-Agent': 'Mozilla/5.0 (Unknown; Linux armv7l) AppleWebKit/537.1+ (KHTML, like Gecko) Safari/537.1+ Stalker portal (0.5.66/0.5.66/1.0)',
            'Referer': config.url.replace(/\/$/, "") + "/c/",
            'Accept': '*/*',
            'Connection': 'keep-alive'
        }).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';

        const { spawn } = require('child_process');
        const ffmpegArgs = [
            '-headers', ffmpegHeaders,
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '5',
            '-fflags', 'nobuffer+discardcorrupt+genpts',
            '-err_detect', 'ignore_err',
            '-i', urlToPlay,
            '-c', 'copy',
            '-f', 'mpegts',
            '-loglevel', 'error',
            'pipe:1'
        ];

        // Se houver proxy HTTP, adiciona (mas o 1º repositório não usa proxy aqui; o user disse que funciona sem proxy)
        // No entanto, para manter a compatibilidade, podemos adicionar a opção se existir proxyUrl.
        const proxyUrl = config.proxy || null;
        if (proxyUrl && proxyUrl.startsWith('http')) {
            ffmpegArgs.unshift('-http_proxy', proxyUrl);
        }

        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        const source = ffmpeg.stdout;
        ffmpeg.on('error', (err) => {
            console.error(`[STALKER ENGINE] Erro no FFmpeg exato: ${err.message}`);
        });
        ffmpeg.on('close', (code) => {
            console.log(`[STALKER ENGINE] FFmpeg exato encerrado (código ${code}).`);
            // Não chamamos onCloseCallback para evitar loops desnecessários;
            // o tratamento de reconexão será feito pelo código que chamou este método.
        });
        source.kill = () => { if (!ffmpeg.killed) ffmpeg.kill('SIGKILL'); };
        return { success: true, source, method: 'ffmpeg-exact' };
    } catch (e) {
        return { success: false };
    }
}

// ============================================================
// EXPORTAÇÕES
// ============================================================
module.exports = {
    authenticate,
    createStreamLink,
    startFfmpegRelay,
    generateFiller,
    SessionManager,
    getAxiosOpts,
    authCache,
    CACHE_TTL,
    tryMultiplePipelines,
    tryFfmpegModernRelay,
    tryFfmpegStreamLegacy,
    tryFfmpegExact
};
