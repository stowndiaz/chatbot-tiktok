const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');
const { WebcastPushConnection } = require('tiktok-live-connector');

const tiktokUsername = process.env.TIKTOK_USERNAME || 'zr_amarillas';
const overlayPort = Number(process.env.PORT || process.env.OVERLAY_PORT || 3000);
const overlayHost = process.env.OVERLAY_HOST || '0.0.0.0';
const followerGoalStart = Number(process.env.FOLLOWER_GOAL_START || 0);
const followerGoalTarget = Number(process.env.FOLLOWER_GOAL_TARGET || 100);
const publicDir = path.join(__dirname, 'public');

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
        .normalize('NFKD')
        .replace(/[^\x00-\x7F]+/g, '')
        .replace(/([a-zA-Z])\1{2,}/g, '$1$1')
        .replace(/[^a-zA-Z0-9 @]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
};

const mimeTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8'
};

const server = http.createServer((req, res) => {
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
