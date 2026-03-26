const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');
const { WebcastPushConnection } = require('tiktok-live-connector');

const source = (process.env.SOURCE || 'tiktok').toLowerCase();
const tiktokUsername = process.env.TIKTOK_USERNAME || 'multi_twentyone';
const overlayPort = Number(process.env.PORT || process.env.OVERLAY_PORT || 3000);
const overlayHost = process.env.OVERLAY_HOST || '0.0.0.0';
const followerGoalStart = Number(process.env.FOLLOWER_GOAL_START || 0);
const followerGoalTarget = Number(process.env.FOLLOWER_GOAL_TARGET || 100);
const publicDir = path.join(__dirname, 'public');
const speechKey = process.env.SPEECH_KEY || process.env.AZURE_SPEECH_KEY || '';
const speechRegion = process.env.SPEECH_REGION || process.env.AZURE_SPEECH_REGION || '';
const speechVoice = process.env.SPEECH_VOICE || 'es-MX-DaliaNeural';
const youtubeApiKey = process.env.YOUTUBE_API_KEY || '';
const youtubeLiveUrl = process.env.YOUTUBE_LIVE_URL || '';
const youtubeLiveVideoId = process.env.YOUTUBE_LIVE_VIDEO_ID || '';
const youtubeChannelId = process.env.YOUTUBE_CHANNEL_ID || '';
const youtubeChannelHandle = process.env.YOUTUBE_CHANNEL_HANDLE || '';
const youtubePollMinMs = Number(process.env.YOUTUBE_POLL_MIN_MS || 1500);
const youtubeLikesPollMinMs = Number(process.env.YOUTUBE_LIKES_POLL_MIN_MS || 9000);

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
            'User-Agent': 'live-overlay-telemetry'
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
    overlayState.chat = overlayState.chat.slice(0, 12);
    broadcast({ type: 'chat', payload: overlayState.chat });
};

const updateTopLikes = () => {
    overlayState.topLikes = Array.from(likeTotals.entries())
        .map(([uniqueId, likes]) => ({ uniqueId, likes }))
        .sort((a, b) => b.likes - a.likes)
        .slice(0, 5);

    broadcast({ type: 'likes', payload: overlayState.topLikes });
};

const setLiveStatus = (connected, roomId) => {
    overlayState.liveStatus = {
        connected: Boolean(connected),
        roomId: roomId || null
    };
    broadcast({ type: 'liveStatus', payload: overlayState.liveStatus });
};

const handleChatEvent = (username, comment) => {
    const cleanUser = cleanUsername(username || 'viewer') || 'viewer';
    const cleanComment = cleanMessage(cleanMentions(comment || ''));
    if (!cleanComment) return;

    const spokenMessage = `${cleanUser}: ${cleanComment}`;

    broadcast({
        type: 'tts',
        payload: {
            text: spokenMessage,
            createdAt: Date.now()
        }
    });

    pushChatToOverlay({
        uniqueId: cleanUser,
        comment: cleanComment,
        createdAt: Date.now()
    });
};

const handleGiftEvent = (username, giftName, repeatCount = 1) => {
    overlayState.lastGift = {
        uniqueId: cleanUsername(username || 'viewer') || 'viewer',
        giftName: cleanMessage(giftName || 'Gift'),
        repeatCount: Number(repeatCount || 1),
        createdAt: Date.now()
    };

    broadcast({ type: 'gift', payload: overlayState.lastGift });
};

const pickAvatarUrl = (avatarCandidate) => {
    if (!avatarCandidate) return '';
    if (typeof avatarCandidate === 'string') return avatarCandidate;
    if (Array.isArray(avatarCandidate)) {
        const firstString = avatarCandidate.find((item) => typeof item === 'string');
        return firstString || '';
    }
    if (typeof avatarCandidate === 'object') {
        const values = Object.values(avatarCandidate);
        const firstString = values.find((item) => typeof item === 'string');
        if (firstString) return firstString;
    }
    return '';
};

const emitLikeBurst = (payload) => {
    broadcast({ type: 'likeBurst', payload: {
        uniqueId: payload.uniqueId || 'viewer',
        count: Number(payload.count || 1),
        source: payload.source || 'tiktok',
        avatarUrl: payload.avatarUrl || '',
        createdAt: Date.now()
    } });
};

const handleLikeEvent = (username, likeCount, sourceName = 'tiktok', avatarCandidate = '') => {
    const user = cleanUsername(username || 'viewer') || 'viewer';
    const count = Number(likeCount || 0);
    likeTotals.set(user, (likeTotals.get(user) || 0) + (count > 0 ? count : 1));
    updateTopLikes();

    emitLikeBurst({
        uniqueId: user,
        count: count > 0 ? count : 1,
        source: sourceName,
        avatarUrl: pickAvatarUrl(avatarCandidate)
    });
};

const handleFollowEvent = (username) => {
    overlayState.followerGoal.current += 1;
    broadcast({ type: 'followGoal', payload: overlayState.followerGoal });
    console.log(`Nuevo follow: ${cleanUsername(username || 'viewer')}`);
};

wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'init', payload: overlayState }));
});

const startTikTokSource = async () => {
    const connection = new WebcastPushConnection(tiktokUsername, {
        enableExtendedGiftInfo: true
    });

    connection.on('connected', (state) => {
        setLiveStatus(true, state.roomId || null);
        console.log(`Conectado a TikTok @${tiktokUsername} (roomId: ${state.roomId})`);
    });

    connection.on('disconnected', () => {
        setLiveStatus(false, overlayState.liveStatus.roomId);
    });

    connection.on('chat', (data) => {
        if (!data.uniqueId || !data.comment) return;
        handleChatEvent(data.uniqueId, data.comment);
    });

    connection.on('gift', (data) => {
        const fallbackGift = `Gift ${data.giftId || ''}`.trim();
        const giftName = data.giftName || data.extendedGiftInfo?.name || fallbackGift;
        handleGiftEvent(data.uniqueId, giftName, Number(data.repeatCount || 1));
    });

    connection.on('like', (data) => {
        handleLikeEvent(data.uniqueId, data.likeCount, 'tiktok', data.profilePictureUrl || data.profilePictureUrls);
    });

    connection.on('follow', (data) => {
        handleFollowEvent(data.uniqueId);
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

    reconnectTikTok();
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseYouTubeVideoIdFromUrl = (urlValue) => {
    if (!urlValue) return '';

    try {
        const url = new URL(urlValue);

        if (url.hostname.includes('youtu.be')) {
            return url.pathname.replace(/^\//, '').trim();
        }

        if (url.searchParams.get('v')) {
            return url.searchParams.get('v').trim();
        }

        const parts = url.pathname.split('/').filter(Boolean);
        const liveIndex = parts.findIndex((part) => part === 'live');
        if (liveIndex >= 0 && parts[liveIndex + 1]) {
            return parts[liveIndex + 1].trim();
        }
    } catch {
        return '';
    }

    return '';
};

const youtubeFetchJson = async (pathname, params = {}) => {
    const searchParams = new URLSearchParams({ ...params, key: youtubeApiKey });
    const url = `https://www.googleapis.com/youtube/v3/${pathname}?${searchParams.toString()}`;
    const response = await fetch(url);

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`YouTube API ${pathname} ${response.status}: ${text.slice(0, 240)}`);
    }

    return response.json();
};

const findLiveVideoIdForChannel = async () => {
    let channelId = youtubeChannelId;
    if (!channelId && youtubeChannelHandle) {
        const payload = await youtubeFetchJson('search', {
            part: 'snippet',
            q: youtubeChannelHandle,
            type: 'channel',
            maxResults: '5'
        });

        const normalizedHandle = youtubeChannelHandle.trim().replace(/^@/, '').toLowerCase();
        const exactHandleMatch = (payload.items || []).find((item) => {
            const customUrl = item?.snippet?.customUrl || '';
            return customUrl.replace(/^@/, '').toLowerCase() === normalizedHandle;
        });

        channelId = exactHandleMatch?.snippet?.channelId || payload.items?.[0]?.snippet?.channelId || '';
    }

    if (!channelId) return '';

    const payload = await youtubeFetchJson('search', {
        part: 'id',
        channelId,
        eventType: 'live',
        type: 'video',
        maxResults: '1'
    });

    return payload.items?.[0]?.id?.videoId || '';
};

const getActiveLiveChatId = async (videoId) => {
    const payload = await youtubeFetchJson('videos', {
        part: 'liveStreamingDetails,snippet',
        id: videoId
    });

    const item = payload.items?.[0];
    return {
        title: item?.snippet?.title || '',
        activeLiveChatId: item?.liveStreamingDetails?.activeLiveChatId || ''
    };
};

const getYouTubeVideoLikeCount = async (videoId) => {
    const payload = await youtubeFetchJson('videos', {
        part: 'statistics',
        id: videoId
    });

    const rawCount = payload.items?.[0]?.statistics?.likeCount;
    const count = Number(rawCount || 0);
    return Number.isFinite(count) ? count : 0;
};

const superChatLabel = (amountText, currency) => {
    const amount = cleanMessage(amountText || '').trim();
    if (amount) return `SuperChat ${amount}`;
    if (currency) return `SuperChat ${currency}`;
    return 'SuperChat';
};

const startYouTubeSource = async () => {
    if (!youtubeApiKey) {
        throw new Error('Falta YOUTUBE_API_KEY para SOURCE=youtube');
    }

    let videoId = youtubeLiveVideoId || parseYouTubeVideoIdFromUrl(youtubeLiveUrl);
    let liveChatId = '';
    let pageToken = '';
    let lastYouTubeLikeCount = null;
    let nextYouTubeLikesPollAt = 0;

    const ensureLiveChat = async () => {
        if (!videoId) {
            videoId = await findLiveVideoIdForChannel();
        }

        if (!videoId) {
            throw new Error('No se encontro video LIVE de YouTube. Define YOUTUBE_LIVE_VIDEO_ID o YOUTUBE_CHANNEL_ID.');
        }

        const liveDetails = await getActiveLiveChatId(videoId);
        if (!liveDetails.activeLiveChatId) {
            throw new Error(`El video ${videoId} no tiene chat en vivo activo todavia.`);
        }

        liveChatId = liveDetails.activeLiveChatId;
        setLiveStatus(true, `yt:${videoId}`);
        console.log(`Conectado a YouTube LIVE videoId=${videoId} ${liveDetails.title ? `(${liveDetails.title})` : ''}`.trim());
    };

    const pollLoop = async () => {
        while (true) {
            try {
                if (!liveChatId) {
                    await ensureLiveChat();
                }

                const payload = await youtubeFetchJson('liveChatMessages', {
                    part: 'snippet,authorDetails',
                    liveChatId,
                    pageToken,
                    maxResults: '200'
                });

                pageToken = payload.nextPageToken || pageToken;

                for (const item of payload.items || []) {
                    const type = item?.snippet?.type;
                    const username = item?.authorDetails?.displayName || 'viewer';

                    if (type === 'textMessageEvent') {
                        const text = item?.snippet?.displayMessage || '';
                        handleChatEvent(username, text);
                        continue;
                    }

                    if (type === 'superChatEvent') {
                        const amountText = item?.snippet?.superChatDetails?.amountDisplayString || '';
                        const currency = item?.snippet?.superChatDetails?.currency || '';
                        handleGiftEvent(username, superChatLabel(amountText, currency), 1);
                        continue;
                    }

                    if (type === 'superStickerEvent') {
                        const amountText = item?.snippet?.superStickerDetails?.amountDisplayString || '';
                        handleGiftEvent(username, `SuperSticker ${amountText}`.trim(), 1);
                        continue;
                    }

                    if (type === 'newSponsorEvent') {
                        handleGiftEvent(username, 'Nueva membresia', 1);
                    }
                }

                if (Date.now() >= nextYouTubeLikesPollAt) {
                    const currentLikeCount = await getYouTubeVideoLikeCount(videoId);
                    if (lastYouTubeLikeCount !== null && currentLikeCount > lastYouTubeLikeCount) {
                        handleLikeEvent('YouTube', currentLikeCount - lastYouTubeLikeCount, 'youtube', '');
                    }
                    lastYouTubeLikeCount = currentLikeCount;
                    nextYouTubeLikesPollAt = Date.now() + youtubeLikesPollMinMs;
                }

                const apiMs = Number(payload.pollingIntervalMillis || 2000);
                await sleep(Math.max(youtubePollMinMs, apiMs));
            } catch (error) {
                console.error(`YouTube polling error: ${error.message}`);
                setLiveStatus(false, videoId ? `yt:${videoId}` : null);
                await sleep(4000);

                if (!youtubeLiveVideoId && !youtubeLiveUrl) {
                    videoId = '';
                }
                liveChatId = '';
                pageToken = '';
                lastYouTubeLikeCount = null;
                nextYouTubeLikesPollAt = 0;
            }
        }
    };

    pollLoop();
};

server.listen(overlayPort, overlayHost, () => {
    const localIpv4 = Object.values(os.networkInterfaces())
        .flat()
        .find((iface) => iface && iface.family === 'IPv4' && !iface.internal)?.address;

    console.log(`Overlay disponible en http://localhost:${overlayPort}`);
    if (localIpv4) {
        console.log(`Overlay LAN: http://${localIpv4}:${overlayPort}`);
    }
    console.log(`Fuente activa: ${source}`);
});

if (source === 'youtube') {
    startYouTubeSource().catch((error) => {
        console.error(`No se pudo iniciar YouTube source: ${error.message}`);
    });
} else {
    startTikTokSource().catch((error) => {
        console.error(`No se pudo iniciar TikTok source: ${error.message}`);
    });
}
