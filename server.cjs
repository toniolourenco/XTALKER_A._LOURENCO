// server.cjs – Proxy Stalker universal (integrado com stalkerengine)
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { PassThrough } = require('stream');
const { spawn } = require('child_process');
const engine = require("./stalkerengine.cjs");
const addon = require("./addon.cjs");

// ===== LIMPA URLs MANGLED DO PORTAL =====
function extractUrlFix(jsData) {
    if (!jsData) return null;
    let url = jsData?.cmd || jsData?.url || (typeof jsData === 'string' ? jsData : null);
    if (!url && typeof jsData === 'object') {
        url = Object.values(jsData).find(v => typeof v === 'string' && (v.startsWith('http') || v.includes('://')));
    }
    if (!url) return null;

    url = url.trim().replace(/^['"`]?(ffrt|ffmpeg|ffrt2|rtmp)['"`]?\s+/i, "").trim();
    url = url.replace(/[\s\t\r\n]+/g, "");

    try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        const domainLikeRe = /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i;

        for (let i = 1; i < parts.length - 1; i++) {
            if (domainLikeRe.test(parts[i]) && parts[i + 1] === parts[0]) {
                const last = parts[parts.length - 1];
                const fixedPath = '/' + [...parts.slice(0, i), last].join('/');
                const fixedUrl = `${u.protocol}//${u.host}${fixedPath}${u.search}`;
                console.log(`[URL FIX] ${fixedUrl}`);
                return fixedUrl;
            }
        }
        return url;
    } catch(e) {
        return url;
    }
}

// ============================================================
// KEEP-ALIVE: mantém a sessão do portal viva (como um MAG real)
// ============================================================
if (!global.recentConfigs) global.recentConfigs = new Set();
const MAX_RECENT_CONFIGS = 5;

function rememberConfig(configB64) {
    if (!configB64) return;
    global.recentConfigs.add(configB64);
    if (global.recentConfigs.size > MAX_RECENT_CONFIGS) {
        const first = global.recentConfigs.values().next().value;
        global.recentConfigs.delete(first);
    }
}

// Um único envio de get_events (mantém sessão viva)
async function sendKeepAlive(list) {
    try {
        const auth = await engine.authenticate(list, list.proxy);
        if (!auth || !auth.api || !auth.token) return false;

        const url = `${auth.api}type=stb&action=get_events&event_active_id=0&init=0&sn=${auth.authData.sn}&token=${auth.token}&JsHttpRequest=1-0`;
        const res = await axios.get(url, engine.getAxiosOpts(list, {
            headers: auth.authData.headers,
            timeout: 4000
        }));

        // Se o portal devolveu novo token, atualiza a cache
        const newToken = res.data?.js?.token;
        if (newToken && newToken !== auth.token) {
            auth.token = newToken;
            auth.authData.headers['Authorization'] = `Bearer ${newToken}`;
            auth.authData.headers.Cookie = auth.authData.headers.Cookie.replace(/token=[^;]+/, `token=${newToken}`);
            auth.authData.headers.Cookie = auth.authData.headers.Cookie.replace(/access_token=[^;]+/, `access_token=${newToken}`);
        }

        return true;
    } catch (e) {
        return false;
    }
}

// Loop background — a cada 2 minutos para cada portal conhecido
setInterval(async () => {
    for (const cfgB64 of global.recentConfigs) {
        try {
            const lists = addon.parseConfig(cfgB64);
            for (const list of lists) {
                if (list.type !== 'stalker') continue;
                const ok = await sendKeepAlive(list);
                if (ok) {
                    console.log(`[KEEPALIVE] ✅ ${list.name || list.url} — sessão viva`);
                }
            }
        } catch(e) { /* ignorar */ }
    }
}, 2 * 60 * 1000);   // 2 minutos

const PORT = process.env.PORT || 7860;
const app = express();

app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

// Limpeza periódica
setInterval(() => {
    const now = Date.now();
    if (global.pendingTvPromises) {
        Object.keys(global.pendingTvPromises).forEach(k => {
            if (global.pendingTvPromises[k] && now - global.pendingTvPromises[k].timestamp > 30000) {
                delete global.pendingTvPromises[k];
            }
        });
    }
    if (global.vodCache) {
        Object.keys(global.vodCache).forEach(k => {
            if (now - global.vodCache[k].timestamp > 30000) {
                delete global.vodCache[k];
            }
        });
    }
}, 30000);

app.get("/ping", (req, res) => {
    console.log(`[PING] ${new Date().toISOString()}`);
    res.status(200).send("pong");
});

// Página de Configuração (inalterada)
app.get("/", (req, res) => res.redirect("/configure"));
app.get("/configure", (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html><head><title>𝕏𝕋𝔸𝕃𝕂𝔼ℝ 𝕀𝕀</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            body { font-family: sans-serif; background: #0c0d19; color: white; padding: 20px; }
            .container { max-width: 600px; margin: auto; }
            .list-box { background: #1b1d30; padding: 20px; border-radius: 12px; margin-bottom: 20px; border-left: 5px solid #007bff; position: relative; }
            h3 { margin-top: 0; color: #007bff; font-size: 16px; }
            label { display: block; font-size: 11px; color: #888; margin-top: 8px; font-weight: bold; }
            input, select { width: 100%; padding: 10px; margin: 4px 0; border-radius: 6px; border: 1px solid #333; background: #222; color: white; box-sizing: border-box; }
            .remove-btn { position: absolute; top: 10px; right: 10px; color: #ff4444; cursor: pointer; font-size: 12px; font-weight: bold; }
            .add-btn { background: #28a745; color: white; border: none; padding: 12px; width: 100%; border-radius: 8px; cursor: pointer; font-weight: bold; margin-bottom: 15px; }
            .categories-btn { background: #6f42c1; color: white; border: none; padding: 12px; width: 100%; border-radius: 8px; cursor: pointer; font-weight: bold; margin-bottom: 15px; }
            .install-btn { background: #007bff; color: white; border: none; padding: 18px; width: 100%; border-radius: 8px; cursor: pointer; font-weight: bold; font-size: 18px; }
            .advanced { display: none; background: #141526; padding: 10px; border-radius: 8px; margin-top: 10px; }
            .adv-toggle { color: #007bff; font-size: 12px; cursor: pointer; text-decoration: underline; margin-top: 5px; display: block; }
            .proxy-box { background: rgba(255, 165, 0, 0.1); border: 1px dashed #ffa500; padding: 10px; border-radius: 8px; margin-top: 10px; }
            .proxy-box label { color: #ffa500 !important; }
            /* Estilos para o modal de categorias */
            .modal { display: none; position: fixed; z-index: 1000; left: 0; top: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.8); overflow-y: auto; }
            .modal-content { background: #1b1d30; margin: 40px auto; padding: 25px; border-radius: 12px; max-width: 500px; position: relative; }
            .close-modal { position: absolute; top: 10px; right: 20px; color: #aaa; font-size: 28px; font-weight: bold; cursor: pointer; }
            .close-modal:hover { color: white; }
            .cat-group { margin: 15px 0; }
            .cat-group h4 { color: #007bff; margin: 10px 0 5px; }
            .cat-section { margin: 8px 0; border: 1px solid #252740; border-radius: 6px; overflow: hidden; }
            .cat-section-header { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: #1e2035; cursor: pointer; user-select: none; }
            .cat-section-header:hover { background: #252740; }
            .cat-section-header strong { color: #007bff; font-size: 13px; flex: 1; }
            .cat-section-header .hint { color: #666; font-size: 11px; }
            .cat-section-header .chevron { color: #007bff; font-size: 11px; transition: transform 0.2s; display: inline-block; }
            .cat-section-header .chevron.open { transform: rotate(180deg); }
            .cat-section-body { padding: 6px 8px; display: none; }
            .cat-checkbox { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
            .cat-checkbox input[type="checkbox"] { width: auto; margin: 0; }
            .cat-checkbox label { display: flex; align-items: center; gap: 8px; cursor: pointer; color: #ddd; font-size: 13px; flex: 1; min-width: 0; }
            .cat-checkbox label span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .cat-master { width: auto; margin: 0; }
            .cat-rename { flex: 1; min-width: 0; padding: 4px 6px; border-radius: 4px; border: 1px solid #333; background: #0f1120; color: #aaa; font-size: 11px; box-sizing: border-box; }
            .cat-rename:focus { border-color: #007bff; outline: none; color: #fff; }
            .cat-rename::placeholder { color: #555; font-style: italic; }
            .loading-spinner { text-align: center; color: #aaa; }
        </style></head>
        <body>
            <div class="container">
                <h2 style="text-align:center">𝕏𝕋𝔸𝕃𝕂𝔼ℝ 𝕀𝕀</h2>
                <div id="lists-container"></div>
                <button class="add-btn" onclick="addList()">+ Adicionar Nova Lista (Máx 5)</button>
                <button class="categories-btn" onclick="openCategoryModal()">📋 Escolhe aqui as categorias</button>
                <button class="install-btn" onclick="install()">🚀 INSTALAR NO STREMIO</button>
            </div>

            <div id="categoryModal" class="modal">
                <div class="modal-content">
                    <span class="close-modal" onclick="closeCategoryModal()">&times;</span>
                    <h3>Escolhe as categorias a instalar</h3>
                    <div id="categoryCheckboxes"></div>
                    <button class="add-btn" onclick="saveCategories()" style="margin-top:20px;">✅ Confirmar seleção</button>
                </div>
            </div>

            <script>
                let listCount = 0;
                let selectedCategories = {};

                function addList() {
                    if(listCount >= 5) return alert("Máximo de 5 listas atingido!");
                    listCount++;
                    const id = Date.now() + Math.floor(Math.random() * 1000);
                    const idx = listCount - 1;
                    const html = \`
                        <div class="list-box" id="box-\${id}" data-list-index="\${idx}">
                            <div class="remove-btn" onclick="removeList('\${id}')">REMOVER</div>
                            <h3>LISTA #\${listCount}</h3>

                            <label>TIPO DE LISTA</label>
                          <select class="type" onchange="toggleType(this, '\${id}')">
                            <option value="stalker">Stalker Portal (MAC)</option>
                            <option value="xtream">Xtream Codes (User/Pass)</option>
                            <option value="m3u">M3U (link da lista)</option>   <!-- 👈 NOVA OPÇÃO -->
                         </select>

                            <label>NOME DA LISTA</label>
                            <input type="text" class="name" placeholder="Ex: IPTV Portugal">
                            <label>URL PORTAL / SERVIDOR</label>
                            <input type="text" class="url" placeholder="http://portal.com:8080/c/">

                            <div id="stalker-group-\${id}">
                                <label>MAC ADDRESS</label>
                                <input type="text" class="mac" placeholder="00:1A:79:XX:XX:XX">
                                <label>BOX MODEL</label>
                                <select class="model">
                                    <option value="MAG250">MAG 250</option>
                                    <option value="MAG254">MAG 254</option>
                                    <option value="MAG256">MAG 256</option>
                                    <option value="MAG322">MAG 322</option>
                                </select>
                                <span class="adv-toggle" onclick="toggleAdv('\${id}')">Configurações Avançadas</span>
                                <div class="advanced" id="adv-\${id}">
                                    <label>SERIAL NUMBER (SN)</label><input type="text" class="sn">
                                    <label>DEVICE ID 1</label><input type="text" class="id1">
                                    <label>DEVICE ID 2</label><input type="text" class="id2">
                                    <label>SIGNATURE</label><input type="text" class="sig">
                                </div>
                            </div>

                            <div id="xtream-group-\${id}" style="display:none;">
                                <label>USERNAME</label>
                                <input type="text" class="user" placeholder="O teu utilizador Xtream">
                                <label>PASSWORD</label>
                                <input type="text" class="pass" placeholder="A tua password Xtream">
                            </div>
                                <div id="m3u-group-\${id}" style="display:none;">
                                <label>URL PORTAL / SERVIDOR</label>
                                <input type="text" id="url-field-\${id}" class="url" placeholder="http://portal.com:8080/c/">
                            </div>

                            <div class="proxy-box">
                                <label>🛡️ PROXY / VPN PARA DESBLOQUEIO (Opcional)</label>
                                <input type="text" class="proxy-url" placeholder="http://user:pass@ip:porta">
                                <div style="font-size: 10px; color: #aaa; margin-top: 4px;">Força a ligação por este IP. Útil para servidores teimosos.</div>
                            </div>

                            <span class="adv-toggle" onclick="toggleStreamsOptions('\${id}')">⚙️ Opções de Streams</span>
                            <div class="advanced" id="streams-options-\${id}" style="margin-top:5px;">
                                <div style="display: flex; align-items: center; gap: 15px; margin-top: 5px;">
                                    <label style="display: flex; align-items: center; gap: 5px; font-size:13px;">
                                        <input type="checkbox" class="use-direct" checked> Directo TV
                                    </label>
                                    <label style="display: flex; align-items: center; gap: 5px; font-size:13px;">
                                        <input type="checkbox" class="use-proxy" checked> Proxy Estável
                                    </label>
                                </div>
                                <div style="margin-top: 8px;">
                                    <label style="font-size:11px; color:#888;">Frase extra (aparece no Stremio)</label>
                                    <input type="text" class="stream-hint" placeholder="Ex: clique aqui se ainda der" style="margin-top:2px;">
                                </div>
                            </div>
                        </div>\`;
                    document.getElementById('lists-container').insertAdjacentHTML('beforeend', html);
                }

                function removeList(id) {
                    const box = document.getElementById('box-'+id);
                    if (box) {
                        const idx = box.getAttribute('data-list-index');
                        delete selectedCategories[idx];
                        box.remove();
                    }
                }

                function toggleType(selectEl, id) {
    // Mostrar/Esconder o campo URL consoante o tipo
    const urlField = document.getElementById('url-field-' + id);
    if (urlField) {
        urlField.style.display = (selectEl.value === 'm3u') ? 'none' : 'block';
    }

    // Esconder todos os grupos específicos
    document.getElementById('stalker-group-'+id).style.display = 'none';
    document.getElementById('xtream-group-'+id).style.display = 'none';
    document.getElementById('m3u-group-'+id).style.display = 'none';

    // Mostrar apenas o grupo relevante
    if (selectEl.value === 'xtream') {
        document.getElementById('xtream-group-'+id).style.display = 'block';
    } else if (selectEl.value === 'm3u') {
        document.getElementById('m3u-group-'+id).style.display = 'block';
    } else {
        document.getElementById('stalker-group-'+id).style.display = 'block';
    }
}

                function toggleAdv(id) {
                    const el = document.getElementById('adv-'+id);
                    el.style.display = el.style.display === 'block' ? 'none' : 'block';
                }

                function toggleStreamsOptions(id) {
                    const el = document.getElementById('streams-options-' + id);
                    if (el) {
                        el.style.display = el.style.display === 'block' ? 'none' : 'block';
                    }
                }

                async function openCategoryModal() {
                    const modal = document.getElementById('categoryModal');
                    const container = document.getElementById('categoryCheckboxes');
                    container.innerHTML = '<div class="loading-spinner">A carregar categorias dos servidores...</div>';
                    modal.style.display = 'block';

                    const boxes = document.querySelectorAll('.list-box');
                    if (boxes.length === 0) {
                        container.innerHTML = '<p>Adiciona pelo menos uma lista primeiro.</p>';
                        return;
                    }

                    let html = '';
                    for (let i = 0; i < boxes.length; i++) {
                        const box = boxes[i];
                        const listData = getListDataFromBox(box);
                        if (!listData.url) continue;
                        html += \`<div class="cat-group"><h4>📺 \${listData.name || 'Lista '+(i+1)} (\${listData.type})</h4>\`;
                        try {
                            const response = await fetch('/get-categories', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(listData)
                            });
                            if (!response.ok) throw new Error('Erro ' + response.status);
                            const cats = await response.json();
                            const saved = selectedCategories[i] || { tv: [], movie: [], series: [] };

                            ['tv', 'movie', 'series'].forEach(type => {
    const typeLabel = type === 'tv' ? 'TV' : (type === 'movie' ? 'Filmes' : 'Séries');
    const groupId = \`\${i}_\${type}\`;
    const isFirstConfig = !selectedCategories[i];
    const savedList = (selectedCategories[i] && selectedCategories[i][type]) ? selectedCategories[i][type] : [];
    const total = cats[type] ? cats[type].length : 0;

    html += \`<div class="cat-section">
        <div class="cat-section-header" onclick="toggleSection('\${groupId}')">
            <input type="checkbox" class="cat-master" data-group="\${groupId}" \${isFirstConfig ? 'checked' : ''} onclick="event.stopPropagation();" onchange="toggleAllCats('\${groupId}', this.checked)">
            <strong>\${typeLabel}</strong>
            <span class="hint">\${total} categorias</span>
            <span class="chevron" id="chev-\${groupId}">▼</span>
        </div>
        <div class="cat-section-body" id="body-\${groupId}">\`;

    if (total > 0) {
        cats[type].forEach(cat => {
            let isChecked = isFirstConfig ? true : false;
            let customName = '';
            for (const item of savedList) {
                if (typeof item === 'string' && item === cat) { isChecked = true; break; }
                if (item && item.original === cat) {
                    isChecked = true;
                    if (item.custom && item.custom !== cat) customName = item.custom;
                    break;
                }
            }
            html += \`<div class="cat-checkbox">
                <label>
                    <input type="checkbox" class="cat-check" data-list="\${i}" data-type="\${type}" data-group="\${groupId}" value="\${cat}" \${isChecked ? 'checked' : ''} onchange="updateMasterCheckbox('\${groupId}')">
                    <span title="\${cat}">\${cat}</span>
                </label>
                <input type="text" class="cat-rename" data-list="\${i}" data-type="\${type}" data-original="\${cat}" placeholder="novo nome" value="\${customName}">
            </div>\`;
        });
    } else {
        html += '<p style="color: #555; font-size:11px; margin:2px 0;">Sem categorias</p>';
    }

    html += '</div></div>';
});
                        } catch (e) {
                            html += '<p style="color: red;">Erro ao obter categorias</p>';
                        }
                        html += '</div>';
                    }
                    container.innerHTML = html;
                }

                function closeCategoryModal() {
                    document.getElementById('categoryModal').style.display = 'none';
                }

                function toggleSection(groupId) {
    const body = document.getElementById('body-' + groupId);
    const chev = document.getElementById('chev-' + groupId);
    if (!body) return;
    if (body.style.display === 'block') {
        body.style.display = 'none';
        if (chev) chev.classList.remove('open');
    } else {
        body.style.display = 'block';
        if (chev) chev.classList.add('open');
    }
}

function toggleAllCats(groupId, checked) {
    document.querySelectorAll(\`.cat-check[data-group="\${groupId}"]\`).forEach(cb => {
        cb.checked = checked;
    });
}

function updateMasterCheckbox(groupId) {
    const all = document.querySelectorAll(\`.cat-check[data-group="\${groupId}"]\`);
    const checked = document.querySelectorAll(\`.cat-check[data-group="\${groupId}"]:checked\`);
    const master = document.querySelector(\`.cat-master[data-group="\${groupId}"]\`);
    if (master) {
        master.checked = all.length > 0 && all.length === checked.length;
        master.indeterminate = checked.length > 0 && checked.length < all.length;
    }
}

                function saveCategories() {
    const newSelection = {};
    document.querySelectorAll('.cat-checkbox').forEach(div => {
        const cb = div.querySelector('.cat-check');
        if (!cb || !cb.checked) return;
        const renameInput = div.querySelector('.cat-rename');
        const listIdx = parseInt(cb.dataset.list);
        const type = cb.dataset.type;
        const original = cb.value;
        const custom = renameInput && renameInput.value.trim() ? renameInput.value.trim() : original;
        if (!newSelection[listIdx]) newSelection[listIdx] = { tv: [], movie: [], series: [] };
        newSelection[listIdx][type].push({ original, custom });
    });
    selectedCategories = newSelection;
    closeCategoryModal();
    alert('Categorias selecionadas guardadas!');
}

                function getListDataFromBox(box) {
                    const type = box.querySelector('.type').value;
                    const getV = (sel) => box.querySelector(sel)?.value?.trim() || "";
                    return {
                        type: type,
                        name: getV('.name') || "IPTV",
                        url: getV('.url'),
                        mac: type === 'stalker' ? getV('.mac') : "",
                        model: type === 'stalker' ? getV('.model') : "MAG250",
                        sn: getV('.sn'),
                        id1: getV('.id1'),
                        id2: getV('.id2'),
                        sig: getV('.sig'),
                        user: type === 'xtream' ? getV('.user') : "",
                        pass: type === 'xtream' ? getV('.pass') : "",
                        m3uUrl: getV('.m3u-url') || (type === 'm3u' ? getV('.url') : ''),
                        proxy: getV('.proxy-url'),
                        useDirect: box.querySelector('.use-direct')?.checked !== false,
                        useProxy: box.querySelector('.use-proxy')?.checked !== false,
                        streamHint: getV('.stream-hint')
                    };
                }

                function install() {
                    const boxes = document.querySelectorAll('.list-box');
                    if(boxes.length === 0) return alert("Adiciona pelo menos uma lista!");

                    try {
                        const lists = Array.from(boxes).map((box, index) => {
                            const listData = getListDataFromBox(box);
                            listData.selectedCategories = selectedCategories[index] || null;
                            return listData;
                        });

                        const config = { lists: lists };
                        const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(config))));
                        window.location.href = "stremio://" + window.location.host + "/" + encodeURIComponent(b64) + "/manifest.json";

                    } catch (err) {
                        console.error("Erro na instalação:", err);
                        alert("Erro ao gerar configuração.");
                    }
                }
                              
                window.onload = function() { addList(); };
            </script>
        </body></html>
    `);
});

// Rotas do Stremio
/*
// ===== METADATA SHIELD =====
app.get("/meta/:config/:listIdx/:channelId", async (req, res) => {
    const { config, listIdx, channelId } = req.params;
    const type = req.query.type || 'tv';
    const lists = addon.parseConfig(config);
    const configData = lists[listIdx];
    if (!configData) return res.status(400).end();

    const key = `${config.slice(0,20)}_${channelId}`;
    if (!global.metaShield) global.metaShield = {};
    const now = Date.now();

        // 2º pedido em < 60s = reprodução
    if (global.metaShield[key] && now - global.metaShield[key] < 60000) {
        const realUrl = global.metaShield[key + '_real'];
        if (!realUrl) return res.status(500).end();

        global.metaShield[key + '_hits'] = (global.metaShield[key + '_hits'] || 0) + 1;
        const hits = global.metaShield[key + '_hits'];

        // ===== PRE-LOCK SINCRONO (só 1 vez por sessão) =====
        if (!global.metaShield[key + '_prelock_done']) {
            console.log(`[META-SHIELD] Hit ${hits} → pre-lock sincrono (a aquecer portal)`);
            try {
                const auth = global.metaShield[key + '_auth'] || await engine.authenticate(configData, configData.proxy);
                if (auth) {
                    const streamHeaders = {
                        ...auth.authData.headers,
                        'Referer': configData.url.replace(/\/$/, '') + '/c/',*/
                       // 'Accept': '*/*',
                     /*   'Connection': 'keep-alive'
                    };
                    const preRes = await axios.get(realUrl, { headers: streamHeaders, responseType: 'stream', timeout: 8000 });
                    let buf = Buffer.alloc(0);
                    await new Promise((resolve) => {
                        const t = setTimeout(resolve, 3000);
                        preRes.data.on('data', (chunk) => {
                            buf = Buffer.concat([buf, chunk]);
                            if (buf.length >= 64 * 1024) {
                                clearTimeout(t);
                                preRes.data.pause();
                                resolve();
                            }
                        });
                        preRes.data.on('error', () => { clearTimeout(t); resolve(); });
                    });
                    global.metaShield[key + '_prelock_source'] = preRes.data;
                    global.metaShield[key + '_prelock_done'] = true;
                    console.log(`[PRE-LOCK] ✅ ${buf.length} bytes lidos — portal quente`);
                }
            } catch(e) {
                console.log(`[PRE-LOCK] Falhou: ${e.message}`);
            }
        } // Fim do PRE-LOCK SINCRONO

        // Hits 4+: pre-lock (fallback)
if (!global.metaShield[key + '_prelock']) {
    global.metaShield[key + '_prelock'] = true;
    (async () => {
        try {
            const auth = global.metaShield[key + '_auth'] || await engine.authenticate(configData, configData.proxy);
            if (!auth) return;
            const streamHeaders = {
                ...auth.authData.headers,
                'Referer': configData.url.replace(/\/$/, '') + '/c/',*/
               // 'Accept': '*/*',
              /*  'Connection': 'keep-alive'
            };
            const preRes = await axios.get(realUrl, { headers: streamHeaders, responseType: 'stream', timeout: 8000 });
            let buf = Buffer.alloc(0);
            const preSource = preRes.data;
            preSource.on('data', (chunk) => {
                buf = Buffer.concat([buf, chunk]);
                if (buf.length >= 64 * 1024) {
                    preSource.pause();
                    console.log(`[PRE-LOCK] Hit ${hits} → pre-lock ativo (${buf.length} bytes)`);
                }
            });
            preSource.on('error', () => {});
            global.metaShield[key + '_prelock_source'] = preSource;
            setTimeout(() => {
                try { preSource.destroy(); } catch(e) {}
                delete global.metaShield[key + '_prelock_source'];
                delete global.metaShield[key + '_prelock'];
            }, 60000);
        } catch(e) {
            console.log(`[PRE-LOCK] Falhou: ${e.message}`);
        }
    })();
}

        // ÚNICO REDIRECT (substitui os dois que existiam e fecha o IF)
        console.log(`[META-SHIELD] Hit ${hits} → redirect efetuado`);
        return res.redirect(302, realUrl);
    } 

    // 1º pedido = metadata
    global.metaShield[key] = now;


    // Cria o URL real do portal em background
    try {
        const auth = await engine.authenticate(configData, configData.proxy);
        if (!auth) return res.status(401).end();
        const stalkerCmd = decodeURIComponent(channelId);
        let streamUrl = await engine.createStreamLink(auth, configData, stalkerCmd, 'tv', null);
        if (streamUrl && streamUrl.trim()) {
            global.metaShield[key + '_auth'] = auth;
            global.metaShield[key + '_real'] = streamUrl.trim();
            global.metaShield[key + '_hits'] = 0;
            console.log(`[META-SHIELD] URL real guardado (limpo): ${streamUrl.substring(0, 70)}...`);
        }
    } catch(e) {
        console.error(`[META-SHIELD] Erro ao criar link: ${e.message}`);
    }

    // Responde com fake TS + Set-Cookie
    const fakeTs = Buffer.alloc(188, 0);
    fakeTs[0] = 0x47;
    const mac = (configData.mac || '').toUpperCase();
    let cookieDomain = '';
    try { cookieDomain = new URL(configData.url).hostname; } catch(e) {}

    res.writeHead(200, {
        'Content-Type': 'video/mp2t',
        'Content-Length': fakeTs.length,
        'Connection': 'close',
        'Set-Cookie': `mac=${encodeURIComponent(mac)}; Path=/; Domain=${cookieDomain}; Max-Age=600`
    });
    res.end(fakeTs);
});

setInterval(() => {
    if (!global.metaShield) return;
    const now = Date.now();
    Object.keys(global.metaShield).forEach(k => {
        if (typeof global.metaShield[k] === 'number' && now - global.metaShield[k] > 120000) {
            if (global.metaShield[k + '_prelock_source'] && global.metaShield[k + '_prelock_source'].destroy) {
                try { global.metaShield[k + '_prelock_source'].destroy(); } catch(e) {}
            }
            delete global.metaShield[k];
            delete global.metaShield[k + '_real'];
            delete global.metaShield[k + '_auth'];
            delete global.metaShield[k + '_hits'];
            delete global.metaShield[k + '_prelock'];
            delete global.metaShield[k + '_prelock_source'];
        }
    });
}, 60000);
*/


// ===== METADATA SHIELD: responde ao metadata probe do Tizen sem tocar no portal =====
app.get("/meta/:config/:listIdx/:channelId", async (req, res) => {
    const { config, listIdx, channelId } = req.params;
    const type = req.query.type || 'tv';
    const lists = addon.parseConfig(config);
    const configData = lists[listIdx];
    if (!configData) return res.status(400).end();

    // Se já vimos este pedido antes (o 2º do Tizen) → redireciona para o portal real
    const key = `${config.slice(0,20)}_${channelId}`;
    if (!global.metaShield) global.metaShield = {};
    const now = Date.now();

    // Se já redirecionámos 1 vez, deixamos o Tizen "preso" com fake TS para ele não reabrir
if (global.metaShield[key] && now - global.metaShield[key] < 60000) {
    const redirectCount = global.metaShield[key + '_redirects'] || 0;
    const realUrl = global.metaShield[key + '_real'];

    if (redirectCount < 1 && realUrl) {
        global.metaShield[key + '_redirects'] = redirectCount + 1;
        console.log(`[META-SHIELD] Redirecionar #${redirectCount + 1} → portal`);
        return res.redirect(302, realUrl);
    }

    // Já redirecionámos antes → Tizen está a insistir, damos fake TS para desistir
    console.log(`[META-SHIELD] Tizen insistiu (${redirectCount + 1}º) → fake TS`);
    const fakeTs = Buffer.alloc(188, 0);
    fakeTs[0] = 0x47;
    res.writeHead(200, {
        'Content-Type': 'video/mp2t',
        'Content-Length': fakeTs.length,
        'Connection': 'close'
    });
    return res.end(fakeTs);
}

    // 1º pedido = metadata → responde com fake TS header
    global.metaShield[key] = now;
    console.log(`[META-SHIELD] 1º pedido (metadata) → a responder localmente`);

    // Cria o URL real do portal em background (para o 2º pedido)
    try {
        const auth = await engine.authenticate(configData, configData.proxy);
        if (!auth) return res.status(401).end();
        const stalkerCmd = decodeURIComponent(channelId);
        const linkUrl = `${auth.api}type=itv&action=create_link&cmd=${encodeURIComponent(stalkerCmd)}&sn=${auth.authData.sn}&token=${auth.token}&JsHttpRequest=1-0`;
const linkRes = await axios.get(linkUrl, engine.getAxiosOpts(configData, { headers: auth.authData.headers, timeout: 5000 }));

// Aplica a limpeza (corrige URLs mangled como crystalott)
let streamUrl = extractUrlFix(linkRes.data?.js);

if (streamUrl && streamUrl.trim()) {
    global.metaShield[key + '_real'] = streamUrl.trim();
    console.log(`[META-SHIELD] URL real guardado (limpo): ${streamUrl.substring(0, 70)}...`);
}
    } catch(e) {
        console.error(`[META-SHIELD] Erro ao criar link: ${e.message}`);
    }

    // Responde com fake TS bytes (sync byte 0x47 + 187 bytes de zeros = 1 packet TS válido)
    const fakeTs = Buffer.alloc(188, 0);
    fakeTs[0] = 0x47; // Sync byte de um pacote MPEG-TS
    res.writeHead(200, {
        'Content-Type': 'video/mp2t',
        'Content-Length': fakeTs.length,
        'Connection': 'close'
    });
    res.end(fakeTs);
});

// Limpeza do metaShield a cada minuto
setInterval(() => {
    if (!global.metaShield) return;
    const now = Date.now();
    Object.keys(global.metaShield).forEach(k => {
        if (typeof global.metaShield[k] === 'number' && now - global.metaShield[k] > 120000) {
            delete global.metaShield[k];
            delete global.metaShield[k + '_real'];
            delete global.metaShield[k + '_redirects'];
        }
    });
}, 60000);

app.get("/:config/manifest.json", async (req, res) => {
    rememberConfig(req.params.config);
    res.json(await addon.getManifest(req.params.config));
});
app.get("/:config/catalog/:type/:id/:extra?.json", async (req, res) => {
    rememberConfig(req.params.config);
    const { config, type, id, extra } = req.params;
    let extraObj = {};
    if (extra) {
        extra.replace(".json", "").split("&").forEach(p => {
            const [k, v] = p.split("=");
            if (k && v) extraObj[k] = decodeURIComponent(v);
        });
    }
    res.json(await addon.getCatalog(type, id, extraObj, config));
});
app.get("/:config/meta/:type/:id.json", async (req, res) => res.json(await addon.getMeta(req.params.type, req.params.id, req.params.config)));
app.get("/:config/stream/:type/:id.json", async (req, res) => {
    rememberConfig(req.params.config);
    const host = req.headers.host;
    res.json(await addon.getStreams(req.params.type, req.params.id, req.params.config, host));
});

// ROTA PRINCIPAL DO PROXY
const sessions = new engine.SessionManager();

app.get("/proxy/:config/:listIdx/:channelId", async (req, res) => {
    const { config, listIdx, channelId } = req.params;
    const type = req.query.type || 'tv';
    const lists = addon.parseConfig(config);
    const configData = lists[listIdx];
    if (!configData) return res.status(400).end();
    console.log(`[PROXY TV] 🔔 Pedido recebido: tipo=${configData.type}, canal=${req.params.channelId}`);

    try {
    // ----- M3U (direct relay) -----
if (configData.type === 'm3u') {
    const m3uUrl = decodeURIComponent(channelId);
    try {
        const axiosOpts = engine.getAxiosOpts(configData, {
            url: m3uUrl,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
                'Connection': 'keep-alive'
            },
            timeout: 30000
        });
        const streamRes = await axios(axiosOpts);
        res.writeHead(200, {
            'Content-Type': streamRes.headers['content-type'] || 'video/mp2t',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });
        streamRes.data.pipe(res);
        req.on('close', () => {
            if (streamRes.data && !streamRes.data.destroyed) streamRes.data.destroy();
        });
    } catch (e) {
        console.error(`[PROXY M3U] Erro: ${e.message}`);
        if (!res.headersSent) res.status(502).end();
    }
    return;   // IMPORTANTE: impedir que caia no tratamento Stalker
}
        // ----- XTREAM (redirect) -----
        if (configData.type === 'xtream') {
    const baseUrl = configData.url.replace(/\/$/, "");
    const finalUrl = type === 'tv' ? `${baseUrl}/${configData.user}/${configData.pass}/${channelId}` :
                     type === 'movie' ? `${baseUrl}/movie/${configData.user}/${configData.pass}/${channelId}` :
                     `${baseUrl}/series/${configData.user}/${configData.pass}/${channelId}`;

    // 1. Obtém cookies de sessão via player_api.php
    let sessionCookies = '';
    try {
        const authUrl = `${baseUrl}/player_api.php?username=${encodeURIComponent(configData.user)}&password=${encodeURIComponent(configData.pass)}`;
        const authRes = await axios.get(authUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3'
            },
            timeout: 5000,
            validateStatus: () => true
        });
        const setCookie = authRes.headers['set-cookie'];
        if (setCookie) {
            sessionCookies = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie;
        }
    } catch (e) {
        console.warn(`[PROXY TV] Não foi possível obter cookies de sessão Xtream.`);
    }

    // 2. Headers para o stream
    const xtreamHeaders = {
        'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
        'Referer': baseUrl + '/c/',
        'Accept': '*/*',
        'Connection': 'keep-alive'
    };
    if (sessionCookies) {
        xtreamHeaders['Cookie'] = sessionCookies;
    }

    // 3. Tenta o stream
    try {
        const axiosOpts = engine.getAxiosOpts(configData, {
            url: finalUrl,
            headers: xtreamHeaders,
            responseType: 'stream',
            timeout: 30000
        });
        const streamRes = await axios(axiosOpts);

        res.writeHead(200, {
            'Content-Type': streamRes.headers['content-type'] || 'video/mp2t',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*'
        });
        streamRes.data.pipe(res);
        req.on('close', () => {
            if (streamRes.data && !streamRes.data.destroyed) streamRes.data.destroy();
        });
    } catch (e) {
        console.error(`[PROXY TV] Erro no relay Xtream: ${e.message}`);
        return res.redirect(302, finalUrl);
    }
    return;  // <-- importante: termina aqui para streams Xtream
}

        // ----- STALKER VOD -----
        if (type === 'movie' || type === 'series') {
            const vodKey = `${configData.url}_${channelId}_${type}`;

            if (!global.pendingVodPromises) global.pendingVodPromises = {};
            if (global.pendingVodPromises[vodKey]) {
                const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000));
                try {
                    const pendingStream = await Promise.race([global.pendingVodPromises[vodKey], timeoutPromise]);
                    if (pendingStream && pendingStream.pipe) {
                        res.writeHead(200, { 'Content-Type': 'video/mp4', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
                        pendingStream.pipe(res);
                        return;
                    }
                } catch (e) {}
                delete global.pendingVodPromises[vodKey];
            }

            if (!global.vodCache) global.vodCache = {};
            let cleanUrl = null;
            if (global.vodCache[vodKey] && (Date.now() - global.vodCache[vodKey].timestamp < 5000)) {
                cleanUrl = global.vodCache[vodKey].url;
            }

            if (!cleanUrl) {
                const auth = await engine.authenticate(configData, configData.proxy);
                if (!auth) return res.status(401).end();

                let stalkerCmd = decodeURIComponent(channelId);
                let seriesParam = '';
                if (type === 'series' && stalkerCmd.includes('|||')) {
                    const parts = stalkerCmd.split('|||');
                    stalkerCmd = parts[0];
                    const epNum = parts[1];
                    if (epNum) seriesParam = `&series=${epNum}`;
                }

                let possibleUrl = stalkerCmd.trim().replace(/^(ffrt|ffmpeg|ffrt2|rtmp)\s+/i, "").trim();
                let isLocalhost = possibleUrl.includes('localhost') || possibleUrl.includes('127.0.0.1');
                
                if ((possibleUrl.startsWith('http://') || possibleUrl.startsWith('https://')) && !isLocalhost) {
                    cleanUrl = possibleUrl;
                } else {
                    const linkUrl = `${auth.api}type=vod&action=create_link&cmd=${encodeURIComponent(stalkerCmd)}${seriesParam}&sn=${auth.authData.sn}&token=${auth.token}&long_lived=1&JsHttpRequest=1-0`;
                    const linkRes = await axios.get(linkUrl, addon.getAxiosOpts(configData, { headers: auth.authData.headers }));
                    let streamUrl = linkRes.data?.js?.cmd || linkRes.data?.js || linkRes.data?.cmd;
                    if (!streamUrl || typeof streamUrl !== 'string') return res.status(404).end();

                    cleanUrl = streamUrl.trim().replace(/^(ffrt|ffmpeg|ffrt2|rtmp)\s+/i, "").trim();
                    if (!cleanUrl.startsWith('http')) {
                        const basePortal = configData.url.split('/c/')[0];
                        cleanUrl = basePortal + (cleanUrl.startsWith('/') ? '' : '/') + cleanUrl;
                    }
                }
                global.vodCache[vodKey] = { url: cleanUrl, timestamp: Date.now() };
            }

            let resolveVod;
            const vodPromise = new Promise(resolve => { resolveVod = resolve; });
            global.pendingVodPromises[vodKey] = vodPromise;

            try {
                const auth = await engine.authenticate(configData, configData.proxy);
                const streamHeaders = {
                    ...auth.authData.headers,
                    'Referer': configData.url.replace(/\/$/, "") + "/c/",
                    'Accept': '*/*',
                    'Connection': 'keep-alive'
                };

                const axiosOpts = addon.getAxiosOpts(configData, {
                    url: cleanUrl,
                    headers: streamHeaders,
                    responseType: 'stream',
                    maxRedirects: 0,
                    validateStatus: () => true
                });
                const streamRes = await axios(axiosOpts);

                if ([301, 302, 307, 308].includes(streamRes.status) && streamRes.headers.location) {
                    const finalUrl = streamRes.headers.location;
                    const finalRes = await axios(addon.getAxiosOpts(configData, {
                        url: finalUrl,
                        headers: streamHeaders,
                        responseType: 'stream'
                    }));
                    pipeVod(finalRes.data, finalRes.status, finalRes.headers, vodKey, resolveVod);
                } else {
                    pipeVod(streamRes.data, streamRes.status, streamRes.headers, vodKey, resolveVod);
                }
            } catch (e) {
                delete global.pendingVodPromises[vodKey];
                if (!res.headersSent) res.status(500).end();
            }

            function pipeVod(source, statusCode, headers, key, resolveFn) {
                if (statusCode >= 400) {
                    source.destroy();
                    delete global.pendingVodPromises[key];
                    return;
                }
                const pipeStream = new PassThrough();
                source.pipe(pipeStream);
                resolveFn(pipeStream);
                delete global.pendingVodPromises[key];

                res.writeHead(200, {
                    'Content-Type': headers['content-type'] || 'video/mp4',
                    'Connection': 'keep-alive',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'no-cache'
                });
                pipeStream.pipe(res);
            }

            return;
        }

        // ========== TV STALKER ==========
const streamKey = `${configData.url}_${channelId}`;

if (!global.activeTvStreams) global.activeTvStreams = {};
if (!global.pendingTvPromises) global.pendingTvPromises = {};
if (!global.linkAttempts) global.linkAttempts = {};
if (!global.linkAttempts[streamKey]) global.linkAttempts[streamKey] = 0;
const MAX_LINK_ATTEMPTS = 2;

// Guarda o último URL que funcionou (para reconexão rápida sem falar com o portal)
if (!global.lastGoodUrl) global.lastGoodUrl = {};

// 1. Se já existe um broadcaster ativo, liga-se a ele
function connectToExistingBroadcaster(cached, res, streamKey, req) {
    if (cached.source && !cached.source.destroyed && cached.broadcaster) {
        console.log(`[PROXY TV] Reconexão rápida detetada. A ligar ao Broadcaster existente...`);
        if (cached.timeout) { clearTimeout(cached.timeout); cached.timeout = null; }
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' });
        cached.broadcaster.pipe(res);
        cached.clients.add(res);
        req.on('close', () => {
            cached.clients.delete(res);
            cached.broadcaster.unpipe(res);
            if (cached.clients.size === 0) {
                cached.timeout = setTimeout(() => {
                    if (cached.source && cached.source.destroy) cached.source.destroy();
                    if (cached.broadcaster) cached.broadcaster.destroy();
                    delete global.activeTvStreams[streamKey];
                }, 15000);
            }
        });
        return true;
    }
    return false;
}

if (global.activeTvStreams[streamKey]) {
    if (connectToExistingBroadcaster(global.activeTvStreams[streamKey], res, streamKey, req)) return;
    else delete global.activeTvStreams[streamKey];
}

if (global.pendingTvPromises[streamKey]) {
    const outcome = await global.pendingTvPromises[streamKey];
    if (outcome && outcome.type === 'redirect') return res.redirect(302, outcome.url);
    if (global.activeTvStreams[streamKey]) return connectToExistingBroadcaster(global.activeTvStreams[streamKey], res, streamKey, req);
}

if (global.linkAttempts[streamKey] >= MAX_LINK_ATTEMPTS) {
    console.log(`[PROXY TV] Número máximo de tentativas de link atingido para este canal.`);
    return res.status(502).json({ error: 'too_many_attempts' });
}

let resolveOutcome;
const outcomePromise = new Promise(resolve => { resolveOutcome = resolve; });
global.pendingTvPromises[streamKey] = outcomePromise;

let auth = null;
let stalkerCmd = decodeURIComponent(channelId);
const possibleUrl = stalkerCmd.trim().replace(/^(ffrt|ffmpeg|ffrt2|rtmp)\s+/i, "").trim();
const isDirectLink = (possibleUrl.startsWith('http://') || possibleUrl.startsWith('https://')) &&
                     !possibleUrl.includes('localhost') && !possibleUrl.includes('127.0.0.1');

const proxyUrl = configData.proxy ? configData.proxy.trim() : null;

let reconnectAttempts = 0;
const MAX_RECONNECT = 5;
const sendError = (msg) => {
    if (!res.headersSent) {
        console.error(`[PROXY TV] ${msg}`);
        res.status(502).json({ error: 'stream_unavailable' });
    }
    delete global.pendingTvPromises[streamKey];
    setTimeout(() => { delete global.linkAttempts[streamKey]; }, 60000);
};

// ---- Funções de pipeline ----
const execFfmpegLegacy = (urlToPlay, streamHeaders) => {
    return new Promise((resolve, reject) => {
        const { spawn } = require('child_process');
        const ffmpegHeaders = Object.entries(streamHeaders)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\r\n') + '\r\n';

        const ffmpeg = spawn('ffmpeg', [
            '-headers', ffmpegHeaders,
            '-re',
            '-i', urlToPlay,
            '-c', 'copy',
            '-f', 'mpegts',
            '-loglevel', 'error',
            'pipe:1'
        ]);

        ffmpeg.stdout.on('data', (chunk) => {
            if (!res.headersSent) {
                res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
            }
            res.write(chunk);
        });

        ffmpeg.on('close', (code) => {
            console.log(`[PROXY TV] Legacy FFmpeg terminou com código ${code}.`);
            resolve(code);
        });
        ffmpeg.on('error', (err) => reject(err));
        req.on('close', () => { if (!ffmpeg.killed) ffmpeg.kill('SIGKILL'); });
    });
};

async function getSource(urlToPlay) {
    const rawHeaders = auth.authData.headers || {};
    const cookieString = rawHeaders['Cookie'] || '';
    const streamHeaders = {
        ...rawHeaders,
        'Cookie': cookieString,
        'Referer': configData.url.replace(/\/$/, "") + "/c/",
        'Accept': '*/*',
        'Connection': 'keep-alive'
    };

    if (stalkerCmd.trim().toLowerCase().startsWith('ffmpeg')) {
        // Usa FFmpeg com reconexão automática
        const ffmpegHeaders = Object.entries({
            ...rawHeaders,
            'Cookie': cookieString,
            'User-Agent': 'Mozilla/5.0 (Unknown; Linux armv7l) AppleWebKit/537.1+ (KHTML, like Gecko) Safari/537.1+ Stalker portal (0.5.66/0.5.66/1.0)',
            'Referer': configData.url.replace(/\/$/, "") + "/c/",
            'Accept': '*/*',
            'Connection': 'keep-alive'
        }).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';

        const source = spawn('ffmpeg', [
            '-headers', ffmpegHeaders,
            '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
            '-fflags', 'nobuffer+discardcorrupt+genpts',
            '-err_detect', 'ignore_err',
            '-i', urlToPlay,
            '-c', 'copy',
            '-f', 'mpegts',
            '-loglevel', 'error',
            'pipe:1'
        ]).stdout;
        source.killProcess = () => { if (!source.killed) source.kill('SIGKILL'); };
        return source;
    } else {
        // Usa Axios direto
        const axiosOpts = addon.getAxiosOpts(configData, {
            url: urlToPlay,
            headers: streamHeaders,
            responseType: 'stream',
            timeout: 8000
        });
        const streamRes = await axios(axiosOpts);
        return streamRes.data;
    }
}

const execStream = async (urlToPlay, isRetry = false) => {
    if (res.headersSent) return;
    if (!isRetry) global.linkAttempts[streamKey]++;

    try {
        const source = await getSource(urlToPlay);
        if (!source) throw new Error('Falha ao obter fonte');

        // Guarda o URL que funcionou
        global.lastGoodUrl[streamKey] = urlToPlay;

        let broadcaster;
        if (global.activeTvStreams[streamKey] && global.activeTvStreams[streamKey].broadcaster) {
            broadcaster = global.activeTvStreams[streamKey].broadcaster;
            if (global.activeTvStreams[streamKey].source.unpipe) global.activeTvStreams[streamKey].source.unpipe();
        } else {
            broadcaster = new PassThrough({ highWaterMark: 1024 * 1024 * 5 });
        }

        source.pipe(broadcaster, { end: false });
        global.activeTvStreams[streamKey] = {
            source: source,
            broadcaster: broadcaster,
            clients: new Set([res]),
            timeout: null,
            renewTimer: null
        };

        if (!res.headersSent) {
            res.writeHead(200, {
                'Content-Type': 'video/mp2t',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*'
            });
            broadcaster.pipe(res);
        }

        resolveOutcome({ type: 'stream' });
        delete global.pendingTvPromises[streamKey];
        global.linkAttempts[streamKey] = 0;

        // ========== RENOVAÇÃO PROATIVA ==========
        const renewInterval = setInterval(async () => {
            console.log(`[PROXY TV] Renovando link proativamente...`);
            try {
                const newAuth = await engine.authenticate(configData, configData.proxy);
                if (newAuth) {
                    auth = newAuth;
                    const linkUrl = `${auth.api}type=itv&action=create_link&cmd=${encodeURIComponent(stalkerCmd)}&sn=${auth.authData.sn}&token=${auth.token}&long_lived=1&JsHttpRequest=1-0`;
                    const linkRes = await axios.get(linkUrl, engine.getAxiosOpts(configData, { headers: auth.authData.headers }));
                    let newStreamUrl = linkRes.data?.js?.cmd || linkRes.data?.js || linkRes.data?.cmd;
                    if (newStreamUrl) {
                        let cUrl = newStreamUrl.trim().replace(/^(ffrt|ffmpeg|ffrt2|rtmp)\s+/i, "").trim();
                        if (!cUrl.startsWith('http')) {
                            const basePortal = configData.url.split('/c/')[0];
                            cUrl = basePortal + (cUrl.startsWith('/') ? '' : '/') + cUrl;
                        }

                        const newSource = await getSource(cUrl);
                        if (newSource) {
                            const cached = global.activeTvStreams[streamKey];
                            if (cached && cached.broadcaster) {
                                // Mata a fonte antiga
                                if (cached.source && cached.source.killProcess) cached.source.killProcess();
                                else if (cached.source && cached.source.destroy) cached.source.destroy();

                                // Pipe da nova fonte para o mesmo broadcaster
                                newSource.pipe(cached.broadcaster, { end: false });
                                cached.source = newSource;
                                global.lastGoodUrl[streamKey] = cUrl;
                                console.log(`[PROXY TV] Link renovado com sucesso.`);
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn(`[PROXY TV] Renovação proativa falhou: ${e.message}`);
            }
        }, 10 * 60 * 1000); // 10 minutos

        global.activeTvStreams[streamKey].renewTimer = renewInterval;

        // Limpa o intervalo quando a stream terminar ou o cliente sair
        source.on('end', () => {
            clearInterval(renewInterval);
            console.log('[PROXY TV] Stream terminou, tentando reconectar...');
            attemptReconnect();
        });
        source.on('error', (err) => {
            clearInterval(renewInterval);
            console.log(`[PROXY TV] Erro na stream: ${err.message}. Tentando reconectar...`);
            attemptReconnect();
        });

        req.on('close', () => {
            const cached = global.activeTvStreams[streamKey];
            if (cached) {
                if (cached.renewTimer) clearInterval(cached.renewTimer);
                cached.clients.delete(res);
                cached.broadcaster.unpipe(res);
                if (cached.clients.size === 0) {
                    if (cached.timeout) clearTimeout(cached.timeout);
                    cached.timeout = setTimeout(() => {
                        if (cached.clients && cached.clients.size === 0) {
                            if (cached.source && cached.source.killProcess) cached.source.killProcess();
                            else if (cached.source && cached.source.destroy) cached.source.destroy();
                            cached.broadcaster.destroy();
                            delete global.activeTvStreams[streamKey];
                        }
                    }, 10 * 60 * 1000);
                }
            }
        });

    } catch (e) {
        console.error(`[PROXY TV] Erro ao obter stream: ${e.message}`);
        if (!isRetry) {
            // Tenta renovar token e link
            try {
                const newAuth = await engine.authenticate(configData, configData.proxy);
                if (newAuth) {
                    auth = newAuth;
                    const linkUrl = `${auth.api}type=itv&action=create_link&cmd=${encodeURIComponent(stalkerCmd)}&sn=${auth.authData.sn}&token=${auth.token}&long_lived=1&JsHttpRequest=1-0`;
                    const linkRes = await axios.get(linkUrl, engine.getAxiosOpts(configData, { headers: auth.authData.headers }));
                    let newStreamUrl = linkRes.data?.js?.cmd || linkRes.data?.js || linkRes.data?.cmd;
                    if (newStreamUrl) {
                        let cUrl = newStreamUrl.trim().replace(/^(ffrt|ffmpeg|ffrt2|rtmp)\s+/i, "").trim();
                        if (!cUrl.startsWith('http')) {
                            const basePortal = configData.url.split('/c/')[0];
                            cUrl = basePortal + (cUrl.startsWith('/') ? '' : '/') + cUrl;
                        }
                        return execStream(cUrl, true);
                    }
                }
            } catch(err) {}
        }
        delete global.pendingTvPromises[streamKey];
        if (!res.headersSent) res.status(502).end();
    }
};

async function attemptReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT) {
        if (global.activeTvStreams[streamKey]) {
            global.activeTvStreams[streamKey].broadcaster.end();
            delete global.activeTvStreams[streamKey];
        }
        sendError('Falha na reconexão automática');
        return;
    }
    reconnectAttempts++;
    console.log(`[PROXY TV] Tentativa de reconexão ${reconnectAttempts}/${MAX_RECONNECT}...`);
    try {
        if (isDirectLink) {
            const lastUrl = global.lastGoodUrl[streamKey] || possibleUrl;
            return execStream(lastUrl, true);
        }
        const newAuth = await engine.authenticate(configData, configData.proxy);
        if (!newAuth) throw new Error('Falha na autenticação');
        auth = newAuth;
        const linkUrl = `${newAuth.api}type=itv&action=create_link&cmd=${encodeURIComponent(stalkerCmd)}&sn=${newAuth.authData.sn}&token=${newAuth.token}&long_lived=1&JsHttpRequest=1-0`;
        const linkRes = await axios.get(linkUrl, engine.getAxiosOpts(configData, { headers: newAuth.authData.headers }));
        let newStreamUrl = linkRes.data?.js?.cmd || linkRes.data?.js || linkRes.data?.cmd;
        if (!newStreamUrl) throw new Error('Link não obtido');
        let cUrl = newStreamUrl.trim().replace(/^(ffrt|ffmpeg|ffrt2|rtmp)\s+/i, "").trim();
        if (!cUrl.startsWith('http')) {
            const basePortal = configData.url.split('/c/')[0];
            cUrl = basePortal + (cUrl.startsWith('/') ? '' : '/') + cUrl;
        }
        await execStream(cUrl, true);
    } catch (err) {
        console.log(`[PROXY TV] Reconexão falhou: ${err.message}`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        await attemptReconnect();
    }
}

// Início da lógica de obtenção do primeiro link
try {
    auth = await engine.authenticate(configData, configData.proxy);
    if (!auth) {
        delete global.pendingTvPromises[streamKey];
        return res.status(401).end();
    }

    let cleanUrl = null;
    if (isDirectLink) {
        cleanUrl = possibleUrl;
    } else {
        const linkUrl = `${auth.api}type=itv&action=create_link&cmd=${encodeURIComponent(stalkerCmd)}&sn=${auth.authData.sn}&token=${auth.token}&long_lived=1&JsHttpRequest=1-0`;
        const linkRes = await axios.get(linkUrl, engine.getAxiosOpts(configData, { headers: auth.authData.headers }));
        let streamUrl = linkRes.data?.js?.cmd || linkRes.data?.js || linkRes.data?.cmd;
        if (!streamUrl || typeof streamUrl !== 'string') {
            delete global.pendingTvPromises[streamKey];
            return res.status(404).end();
        }
        cleanUrl = streamUrl.trim().replace(/^(ffrt|ffmpeg|ffrt2|rtmp)\s+/i, "").trim();
        if (!cleanUrl.startsWith('http')) {
            const basePortal = configData.url.split('/c/')[0];
            cleanUrl = basePortal + (cleanUrl.startsWith('/') ? '' : '/') + cleanUrl;
        }
    }
    console.log(`[PROXY TV] Link obtido do portal: ${cleanUrl}`);
    execStream(cleanUrl);
} catch (e) {
    console.error("[PROXY] Erro interno no pipe TV:", e.message);
    delete global.pendingTvPromises[streamKey];
    if (!res.headersSent) res.status(500).end();
}

} catch (e) {
    console.error("[PROXY] Erro geral do router:", e.message);
    if (!res.headersSent) res.status(500).end();
}

});

app.post("/get-categories", async (req, res) => {
    try {
        const listConfig = req.body;
        if (!listConfig || (!listConfig.url && listConfig.type !== 'm3u')) {
    return res.status(400).json({ error: "Configuração inválida" });
}

        let tvCategories = [];
        let movieCategories = [];
        let seriesCategories = [];

        if (listConfig.type === 'xtream') {
            const base = listConfig.url.replace(/\/$/, "");
            const api = `${base}/player_api.php?username=${encodeURIComponent(listConfig.user)}&password=${encodeURIComponent(listConfig.pass)}`;
            try {
                const [liveCat, vodCat, seriesCat] = await Promise.all([
                    axios.get(`${api}&action=get_live_categories`, { timeout: 5000 }).catch(() => ({ data: [] })),
                    axios.get(`${api}&action=get_vod_categories`, { timeout: 5000 }).catch(() => ({ data: [] })),
                    axios.get(`${api}&action=get_series_categories`, { timeout: 5000 }).catch(() => ({ data: [] }))
                ]);
                tvCategories = (liveCat.data || []).map(c => c.category_name).filter(Boolean);
                movieCategories = (vodCat.data || []).map(c => c.category_name).filter(Boolean);
                seriesCategories = (seriesCat.data || []).map(c => c.category_name).filter(Boolean);
            } catch (e) {
                console.error("Erro Xtream ao obter categorias:", e.message);
            }

             } else if (listConfig.type === 'm3u') {
    try {
        const m3uRes = await axios.get(listConfig.m3uUrl, { timeout: 15000, responseType: 'text' });
        const lines = m3uRes.data.split('\n');
        const groups = new Set();
        for (const line of lines) {
            if (line.startsWith('#EXTINF:')) {
                const groupMatch = line.match(/group-title="([^"]+)"/);
                if (groupMatch) groups.add(groupMatch[1]);
            }
        }
        tvCategories = [...groups].filter(Boolean);
    } catch (e) {
        console.error("Erro ao obter categorias M3U:", e.message);
    }
            
        } else {
            try {
                const auth = await engine.authenticate(listConfig, listConfig.proxy);
                if (auth) {
                    const opts = engine.getAxiosOpts(listConfig, { headers: auth.authData.headers, timeout: 5000 });
                    const apiBase = auth.api;

                    const fetchStalkerCategories = async (type, action) => {
                        try {
                            const resp = await axios.get(
                                `${apiBase}type=${type}&action=${action}&sn=${auth.authData.sn}&token=${auth.token}&JsHttpRequest=1-0`,
                                opts
                            );
                            const data = resp.data?.js?.data || resp.data?.js || [];
                            const items = Array.isArray(data) ? data : Object.values(data);
                            return items.map(g => g.title || g.name).filter(Boolean);
                        } catch (e) {
                            return [];
                        }
                    };

                    [tvCategories, movieCategories, seriesCategories] = await Promise.all([
                        fetchStalkerCategories('itv', 'get_genres'),
                        fetchStalkerCategories('vod', 'get_categories'),
                        fetchStalkerCategories('series', 'get_categories')
                    ]);
                }
            } catch (e) {
                console.error("Erro Stalker ao obter categorias:", e.message);
            }
        }

       // Remove categorias indesejadas (ignorando espaços e capitalização)
const isUndesired = (cat) => {
    const clean = (cat || '').trim().toLowerCase();
    return clean === 'predefinido' || clean === 'default';
};
tvCategories = tvCategories.filter(cat => !isUndesired(cat));
movieCategories = movieCategories.filter(cat => !isUndesired(cat));
seriesCategories = seriesCategories.filter(cat => !isUndesired(cat));

        res.json({
            tv: [...new Set(tvCategories)],
            movie: [...new Set(movieCategories)],
            series: [...new Set(seriesCategories)]
        });
    } catch (error) {
        console.error("Erro na rota /get-categories:", error);
        res.status(500).json({ error: "Erro interno" });
    }
});

app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Addon Online na porta ${PORT}`));
