const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');
const { WebcastPushConnection } = require('tiktok-live-connector');

const tiktokUsername = process.env.TIKTOK_USERNAME || 'multi_twentyone';
const overlayPort = Number(process.env.PORT || process.env.OVERLAY_PORT || 3000);
const overlayHost = process.env.OVERLAY_HOST || '0.0.0.0';
const followerGoalStart = Number(process.env.FOLLOWER_GOAL_START || 0);
const followerGoalTarget = Number(process.env.FOLLOWER_GOAL_TARGET || 100);
const publicDir = path.join(__dirname, 'public');
const speechKey = process.env.SPEECH_KEY || process.env.AZURE_SPEECH_KEY || '';
const speechRegion = process.env.SPEECH_REGION || process.env.AZURE_SPEECH_REGION || '';
const speechVoice = process.env.SPEECH_VOICE || 'es-MX-DaliaNeural';

const connection = new WebcastPushConnection(tiktokUsername, {
    enableExtendedGiftInfo: true
});

const likeTotals = new Map();

const overlayState = {
    chat: [],
    topLikes: [],
    followerGoal: {
        start: followerGoalStart,
        current: followerGoalStart,
        target: followerGoalTarget
    },
    lastGift: null,
    liveStatus: {
        connected: false,
        roomId: null
    }
};

const cleanUsername = (username = '') => {
    return username.replace(/[_\-.]/g, ' ').replace(/\d+/g, '').trim();
};

const cleanMentions = (comment = '') => {
    return comment.replace(/@([\w.\-_]+)/g, (_, username) => `@${cleanUsername(username)}`);
};

const cleanMessage = (message = '') => {
    return message
        .replace(/([\p{L}])\1{2,}/gu, '$1$1')
        .replace(/[^\p{L}\p{N}\s@.,!?¿¡:;'"\-]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
};

const parseJsonBody = (req) => {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', (chunk) => {
            raw += chunk;
            if (raw.length > 50_000) {
                reject(new Error('Payload demasiado grande'));
            }
        });
        req.on('end', () => {
            if (!raw) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch {
                reject(new Error('JSON invalido'));
            }
        });
        req.on('error', reject);
    });
};

const escapeXml = (value = '') => {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
};

const synthesizeAzureTTS = async (text) => {
    if (!speechKey || !speechRegion) {
        throw new Error('Azure TTS no configurado');
    }

    const endpoint = `https://${speechRegion}.tts.speech.microsoft.com/cognitiveservices/v1`;
    const ssml = `<speak version='1.0' xml:lang='es-MX'><voice name='${speechVoice}'><prosody rate='-4%' pitch='0%'>${escapeXml(text)}</prosody></voice></speak>`;
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/ssml+xml',
            'Ocp-Apim-Subscription-Key': speechKey,
            'X-Microsoft-OutputFormat': 'audio-48khz-192kbitrate-mono-mp3',
            'User-Agent': 'tiktok-overlay-telemetry'
        },
        body: ssml
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Azure TTS error ${response.status}: ${errorText.slice(0, 240)}`);
    }

    const audioBuffer = await response.arrayBuffer();
    return Buffer.from(audioBuffer);
};

const mimeTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8'
};

const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/tts') {
        try {
            const body = await parseJsonBody(req);
            const rawText = typeof body.text === 'string' ? body.text : '';
            const text = cleanMessage(rawText).slice(0, 280);

            if (!text) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: 'Texto vacio' }));
                return;
            }

            const audio = await synthesizeAzureTTS(text);
            res.writeHead(200, {
                'Cache-Control': 'no-store',
                'Content-Type': 'audio/mpeg',
                'Content-Length': audio.length
            });
            res.end(audio);
            return;
        } catch (error) {
            console.error(`TTS API error: ${error.message}`);
            const status = String(error.message || '').includes('no configurado') ? 503 : 500;
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: error.message || 'No se pudo generar TTS' }));
            return;
        }
    }

    const reqPath = req.url === '/' ? '/index.html' : req.url;
    const safePath = path.normalize(reqPath).replace(/^(\.\.[\\/])+/, '');
    const fullPath = path.join(publicDir, safePath);

    if (!fullPath.startsWith(publicDir)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Forbidden');
        return;
    }

    fs.readFile(fullPath, (error, data) => {
        if (error) {
            const status = error.code === 'ENOENT' ? 404 : 500;
            res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(status === 404 ? 'Not found' : 'Server error');
            return;
        }

        const ext = path.extname(fullPath).toLowerCase();
        res.writeHead(200, {
            'Cache-Control': 'no-store',
            'Content-Type': mimeTypes[ext] || 'application/octet-stream'
        });
        res.end(data);
    });
});

const wss = new WebSocketServer({ server });

const broadcast = (message) => {
    const payload = JSON.stringify(message);
    wss.clients.forEach((client) => {
        if (client.readyState === 1) {
            client.send(payload);
        }
    });
};

const pushChatToOverlay = (entry) => {
    overlayState.chat.unshift(entry);
    overlayState.chat = overlayState.chat.slice(0, 4);
    broadcast({ type: 'chat', payload: overlayState.chat });
};

const updateTopLikes = () => {
    overlayState.topLikes = Array.from(likeTotals.entries())
        .map(([uniqueId, likes]) => ({ uniqueId, likes }))
        .sort((a, b) => b.likes - a.likes)
        .slice(0, 5);

    broadcast({ type: 'likes', payload: overlayState.topLikes });
};

wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'init', payload: overlayState }));
});

connection.on('connected', (state) => {
    overlayState.liveStatus = {
        connected: true,
        roomId: state.roomId || null
    };

    broadcast({ type: 'liveStatus', payload: overlayState.liveStatus });
    console.log(`Conectado a @${tiktokUsername} (roomId: ${state.roomId})`);
});

connection.on('disconnected', () => {
    overlayState.liveStatus.connected = false;
    broadcast({ type: 'liveStatus', payload: overlayState.liveStatus });
});

connection.on('chat', (data) => {
    if (!data.uniqueId || !data.comment) return;

    const cleanUser = cleanUsername(data.uniqueId);
    const comment = cleanMessage(cleanMentions(data.comment));
    const spokenMessage = `${cleanUser}: ${comment}`;

    broadcast({
        type: 'tts',
        payload: {
            text: spokenMessage,
            createdAt: Date.now()
        }
    });

    pushChatToOverlay({
        uniqueId: cleanUser || 'viewer',
        comment,
        createdAt: Date.now()
    });
});

connection.on('gift', (data) => {
    const fallbackGift = `Gift ${data.giftId || ''}`.trim();
    const giftName = data.giftName || data.extendedGiftInfo?.name || fallbackGift;

    overlayState.lastGift = {
        uniqueId: cleanUsername(data.uniqueId || 'viewer'),
        giftName,
        repeatCount: Number(data.repeatCount || 1),
        createdAt: Date.now()
    };

    broadcast({ type: 'gift', payload: overlayState.lastGift });
});

connection.on('like', (data) => {
    const user = cleanUsername(data.uniqueId || 'viewer') || 'viewer';
    const likeCount = Number(data.likeCount || 0);

    likeTotals.set(user, (likeTotals.get(user) || 0) + (likeCount > 0 ? likeCount : 1));
    updateTopLikes();
});

connection.on('follow', (data) => {
    overlayState.followerGoal.current += 1;
    broadcast({ type: 'followGoal', payload: overlayState.followerGoal });
    console.log(`Nuevo follow: ${cleanUsername(data.uniqueId || 'viewer')}`);
});

connection.on('error', (err) => {
    console.error('Error de TikTok:', err.info?.message || err.message || err);
});

const reconnectTikTok = async () => {
    try {
        await connection.connect();
    } catch (err) {
        console.error('No se pudo conectar a TikTok. Reintentando en 5s...', err.message || err);
        setTimeout(reconnectTikTok, 5000);
    }
};

server.listen(overlayPort, overlayHost, () => {
    const localIpv4 = Object.values(os.networkInterfaces())
        .flat()
        .find((iface) => iface && iface.family === 'IPv4' && !iface.internal)?.address;

    console.log(`Overlay disponible en http://localhost:${overlayPort}`);
    if (localIpv4) {
        console.log(`Overlay LAN: http://${localIpv4}:${overlayPort}`);
    }
});

reconnectTikTok();
