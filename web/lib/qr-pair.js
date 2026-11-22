// =====================================================================
// QR Pair — a direct link between two browsers on the same wifi, paired by
// showing QR codes to each other's webcams. No server is involved.
//
// Notes for using and changing this library: web/lib/qr-pair.md
// Tests: uv run tests/qr_pair_test.py --demo
// Demo and reference app: web/qr-pair.html
//
// Quick start (an ES module, so the page must be served over http(s), not file://):
//
//   import { mountPairing } from './lib/qr-pair.js';
//   const pairing = mountPairing(document.querySelector('#pairing'), {
//       app: 'my-game@1',                       // both laptops must use the same name
//       onConnected: (link, { reconnected }) => {
//           // Set handlers right here, before returning, so no message is missed.
//           link.onmessage = (msg, { fast }) => …;
//           link.onstatechange = (state, reason) => …;  // 'connected' | 'unstable' | 'closed'
//           if (pairing.role === 'host') link.send({ t: 'state', … });
//       },
//   });
//   // After the link closes: pairing.start() pairs again in the same role.
//
// Lower-level pieces, for a custom pairing UI:
//   PairCodec  packs the essential WebRTC fields into ~100-character codes
//   PeerLink   one RTCPeerConnection with two JSON channels, a shared clock,
//              and goodbye / reconnect detection
//   QrScanner / drawQrCode  webcam scanning and QR rendering
//   loadQrLibraries  loads the two QR libraries (done automatically when needed)
// =====================================================================

export const QR_PAIR_VERSION = 2;

// ————— The two QR libraries, loaded on demand from CDNs —————
// Integrity hashes pin the exact files, so a tampered CDN copy is refused rather than run.
const QR_LIBRARIES = {
    qrcode: {
        name: 'QR code generator',
        src: 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js',
        integrity: 'sha384-mZT2gIty7ZDdOGkxfP6joZcYdMW1Jvj9dRlfpTmaJAKKXTqzygtB22k7FLe+KZC1',
    },
    jsQR: {
        name: 'QR code reader',
        src: 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
        integrity: 'sha384-b5Ya4Bq3qCyz39m2ISh+4DxjAIljdeFwK/BsXLuj9gugaNwAcj/ia15fxNZL9Nlx',
    },
};
const scriptLoads = new Map();

// Both libraries are classic scripts that define a global function of the same name.
const loadGlobal = (globalName) => {
    if (typeof window[globalName] === 'function') return Promise.resolve(window[globalName]);
    if (!scriptLoads.has(globalName)) {
        const { name, src, integrity } = QR_LIBRARIES[globalName];
        scriptLoads.set(globalName, new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.integrity = integrity;
            script.crossOrigin = 'anonymous';
            script.onload = () => (typeof window[globalName] === 'function'
                ? resolve(window[globalName])
                : reject(new Error(`The ${name} loaded but did not start.`)));
            script.onerror = () => {
                scriptLoads.delete(globalName);    // allow a later retry
                reject(new Error(`Couldn't load the ${name}. Check the internet connection and reload the page.`));
            };
            document.head.append(script);
        }));
    }
    return scriptLoads.get(globalName);
};

export const loadQrLibraries = () => Promise.all([loadGlobal('qrcode'), loadGlobal('jsQR')]);

// ————— PairCodec: WebRTC session details <-> short pairing codes —————
export const PairCodec = (() => {
    // Bump when the code format OR the PeerLink channel protocol changes, so pages that
    // can't talk to each other say so at the scan instead of failing later.
    const VERSION = 2;
    // Crockford base32: no I, L, O or U, so codes are hard to misread. Every character
    // is also in QR "alphanumeric" mode, which packs 5.5 bits per character.
    const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    // ICE ufrag/pwd characters are limited to [A-Za-z0-9+/], so 6 bits each is enough.
    const ICE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const SETUPS = ['actpass', 'active', 'passive'];
    const ADDR = { IPV4: 0, MDNS: 1, IPV6: 2, NAME: 3 };
    const MAX_CANDIDATES = 3;

    const sdpLines = (sdp) => sdp.split(/\r?\n/);
    const sdpValue = (sdp, prefix) => {
        const line = sdpLines(sdp).find(l => l.startsWith(prefix));
        return line ? line.slice(prefix.length).trim() : null;
    };

    // CRC-8 (poly 0x07), used to reject mistyped or corrupted codes.
    const crc8 = (bytes) => {
        let crc = 0;
        for (const b of bytes) {
            crc ^= b;
            for (let i = 0; i < 8; i++) crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xFF : (crc << 1) & 0xFF;
        }
        return crc;
    };

    const toBase32 = (bytes) => {
        let bits = 0, value = 0, out = '';
        for (const b of bytes) {
            value = (value << 8) | b; bits += 8;
            while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
            value &= (1 << bits) - 1;
        }
        if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
        return out;
    };

    const fromBase32 = (text) => {
        // Be forgiving with pasted/typed codes: ignore spaces and dashes, accept look-alikes.
        const clean = text.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/[^0-9A-Z]/g, '');
        const out = [];
        let bits = 0, value = 0;
        for (const ch of clean) {
            const idx = ALPHABET.indexOf(ch);
            if (idx < 0) throw new Error(`Unexpected character "${ch}" in code`);
            value = (value << 5) | idx; bits += 5;
            if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xFF); bits -= 8; }
            value &= (1 << bits) - 1;
        }
        return Uint8Array.from(out);
    };

    // Pack an ICE string at 6 bits per char, prefixed with its length.
    const packIce = (str, out) => {
        if (str.length > 255) throw new Error('ICE credential too long');
        out.push(str.length);
        let bits = 0, value = 0;
        for (const ch of str) {
            const idx = ICE_CHARS.indexOf(ch);
            if (idx < 0) throw new Error(`Unsupported ICE character "${ch}"`);
            value = (value << 6) | idx; bits += 6;
            while (bits >= 8) { out.push((value >>> (bits - 8)) & 0xFF); bits -= 8; }
            value &= (1 << bits) - 1;
        }
        if (bits > 0) out.push((value << (8 - bits)) & 0xFF);
    };

    const parseIpv6 = (addr) => {
        const [head, tail = null] = addr.split('::');
        const headParts = head ? head.split(':') : [];
        const tailParts = tail ? tail.split(':') : [];
        const missing = 8 - headParts.length - tailParts.length;
        const groups = tail === null ? headParts : [...headParts, ...Array(missing).fill('0'), ...tailParts];
        if (groups.length !== 8 || !groups.every(g => /^[0-9a-f]{1,4}$/i.test(g))) return null;
        return groups.flatMap(g => { const n = parseInt(g, 16); return [n >> 8, n & 0xFF]; });
    };

    const formatIpv6 = (bytes) => {
        const groups = [];
        for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
        return groups.join(':');
    };

    const UUID_LOCAL = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;
    const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    // Plain DNS-style names only. Anything else from a code could smuggle extra lines or
    // markup into the description we hand to the browser, so it is refused.
    const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

    // Turn an address from a browser description into the bytes we send, or null to skip it.
    const packAddress = (address) => {
        let m;
        if ((m = address.match(IPV4))) {
            const octets = m.slice(1).map(Number);
            return octets.every(n => n <= 255) ? [ADDR.IPV4, ...octets] : null;
        }
        if ((m = address.match(UUID_LOCAL))) {
            const hexId = m.slice(1).join('');
            const bytes = [ADDR.MDNS];
            for (let i = 0; i < 32; i += 2) bytes.push(parseInt(hexId.slice(i, i + 2), 16));
            return bytes;
        }
        if (address.includes(':')) {
            const bytes = parseIpv6(address);
            return bytes ? [ADDR.IPV6, ...bytes] : null;
        }
        const nameBytes = new TextEncoder().encode(address);
        return HOSTNAME.test(address) ? [ADDR.NAME, nameBytes.length, ...nameBytes] : null;
    };

    // Pick the UDP host candidates worth sending. IPv4 and mDNS (.local) names come
    // first; IPv6 is used only if there is nothing else. Link-local IPv4 is skipped.
    const pickCandidates = (sdp) => {
        const found = [];
        for (const line of sdpLines(sdp)) {
            if (!line.startsWith('a=candidate:')) continue;
            const parts = line.slice('a=candidate:'.length).split(' ');
            const [, component, transport, , address, port, , type] = parts;
            if (component !== '1' || transport?.toLowerCase() !== 'udp' || type !== 'host') continue;
            if (address.startsWith('169.254.')) continue;
            const portNumber = Number(port);
            if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) continue;
            const packed = packAddress(address);
            if (!packed) continue;
            if (found.some(c => c.address === address && c.port === portNumber)) continue;
            found.push({ address, port: portNumber, packed });
        }
        const rank = (c) => c.packed[0] === ADDR.IPV4 ? 0 : c.packed[0] === ADDR.MDNS ? 1 : c.packed[0] === ADDR.IPV6 ? 3 : 2;
        found.sort((a, b) => rank(a) - rank(b));
        const nonV6 = found.filter(c => rank(c) < 3);
        return (nonV6.length ? nonV6 : found).slice(0, MAX_CANDIDATES);
    };

    // sdp: a local description after ICE gathering. kind: 'offer' | 'answer'.
    const encode = (sdp, kind) => {
        const ufrag = sdpValue(sdp, 'a=ice-ufrag:');
        const pwd = sdpValue(sdp, 'a=ice-pwd:');
        const fingerprintLine = sdpValue(sdp, 'a=fingerprint:');
        const setup = sdpValue(sdp, 'a=setup:') || 'actpass';
        if (!ufrag || !pwd || !fingerprintLine) throw new Error('Browser description is missing ICE or fingerprint fields');
        const [hashName, hex] = fingerprintLine.split(' ');
        if (hashName.toLowerCase() !== 'sha-256') throw new Error(`Unsupported fingerprint hash ${hashName}`);
        const setupIndex = SETUPS.indexOf(setup);
        if (setupIndex < 0) throw new Error(`Unexpected DTLS setup "${setup}"`);

        const candidates = pickCandidates(sdp);
        if (!candidates.length) throw new Error('No local network address found. Is this laptop connected to wifi?');

        const out = [];
        // Header: version in the top nibble, setup in bits 1-2, answer flag in bit 0.
        out.push((VERSION << 4) | (setupIndex << 1) | (kind === 'answer' ? 1 : 0));
        packIce(ufrag, out);
        packIce(pwd, out);
        const fp = hex.split(':').map(h => parseInt(h, 16));
        if (fp.length !== 32 || fp.some(n => !(n >= 0 && n <= 255))) throw new Error('Unexpected fingerprint length');
        out.push(...fp);
        out.push(candidates.length);
        for (const { port, packed } of candidates) out.push(...packed, port >> 8, port & 0xFF);
        out.push(crc8(out));
        return toBase32(out);
    };

    const decode = (code) => {
        const bytes = fromBase32(code);
        if (bytes.length < 40) throw new Error('Code is too short');
        if (crc8(bytes.subarray(0, bytes.length - 1)) !== bytes[bytes.length - 1]) {
            throw new Error('Code checksum does not match. Was it copied completely?');
        }
        let pos = 0;
        const need = (n) => { if (pos + n > bytes.length - 1) throw new Error('Code is truncated'); };
        const take = (n) => { need(n); const s = bytes.subarray(pos, pos + n); pos += n; return s; };
        const unpackIce = () => {
            const len = take(1)[0];
            const packed = take(Math.ceil(len * 6 / 8));
            let bits = 0, value = 0, str = '';
            for (const b of packed) {
                value = (value << 8) | b; bits += 8;
                while (bits >= 6 && str.length < len) { str += ICE_CHARS[(value >>> (bits - 6)) & 63]; bits -= 6; }
                value &= (1 << bits) - 1;
            }
            return str;
        };

        const header = take(1)[0];
        if ((header >> 4) !== VERSION) throw new Error('This code came from a different version of the page');
        const kind = (header & 1) ? 'answer' : 'offer';
        const setup = SETUPS[(header >> 1) & 3];
        if (!setup) throw new Error('Code has an invalid header');
        const ufrag = unpackIce();
        const pwd = unpackIce();
        // ICE requires at least 4 and 22 characters (RFC 8839).
        if (ufrag.length < 4 || pwd.length < 22) throw new Error('Code has invalid connection credentials');
        const fingerprint = Array.from(take(32), b => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
        const count = take(1)[0];
        if (count < 1 || count > MAX_CANDIDATES) throw new Error('Code has an invalid address list');
        const candidates = [];
        for (let i = 0; i < count; i++) {
            const type = take(1)[0];
            let address;
            if (type === ADDR.IPV4) address = Array.from(take(4)).join('.');
            else if (type === ADDR.MDNS) {
                const h = Array.from(take(16), b => b.toString(16).padStart(2, '0')).join('');
                address = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`;
            } else if (type === ADDR.IPV6) address = formatIpv6(take(16));
            else if (type === ADDR.NAME) {
                address = new TextDecoder().decode(take(take(1)[0]));
                if (!HOSTNAME.test(address)) throw new Error('Code has an invalid address');
            } else throw new Error('Code has an unknown address type');
            const [hi, lo] = take(2);
            const port = (hi << 8) | lo;
            if (port === 0) throw new Error('Code has an invalid port');
            candidates.push({ address, port });
        }
        return { kind, setup, ufrag, pwd, fingerprint, candidates, byteLength: bytes.length };
    };

    // Rebuild a minimal but complete remote description for a data-channel-only session.
    // Every value here was checked by decode(), so nothing can add lines of its own.
    const toSdp = (info, mid = '0') => {
        const lines = [
            'v=0',
            `o=- ${Date.now()} 2 IN IP4 127.0.0.1`,
            's=-',
            't=0 0',
            `a=group:BUNDLE ${mid}`,
            'a=msid-semantic: WMS',
            'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
            'c=IN IP4 0.0.0.0',
            `a=ice-ufrag:${info.ufrag}`,
            `a=ice-pwd:${info.pwd}`,
            `a=fingerprint:sha-256 ${info.fingerprint}`,
            `a=setup:${info.setup}`,
            `a=mid:${mid}`,
            'a=sctp-port:5000',
            'a=max-message-size:262144',
            ...info.candidates.map((c, i) =>
                `a=candidate:${i + 1} 1 udp ${2130706431 - i} ${c.address} ${c.port} typ host`),
            'a=end-of-candidates',
        ];
        return lines.join('\r\n') + '\r\n';
    };

    return { encode, decode, toSdp };
})();

// ————— PeerLink: the connection itself —————
export class PeerLink {
    // Internal message types all start with "__", and games cannot send them.
    static #BYE = '__bye';
    static #HELLO = '__hello';
    static #PING = '__ping';
    static #PONG = '__pong';
    // A random id for this page load, sent to the other side so it can tell a reconnect
    // to the same laptop apart from a new partner.
    static #pageId = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
    static #lastPeerId = null;
    // Fast messages are snapshots, so once a few are queued it is better to drop new ones.
    static #FAST_BACKLOG = 64 * 1024;
    // Chrome closes a channel whose queue passes 16 MB, so refuse well before that.
    static #RELIABLE_BACKLOG = 4 * 1024 * 1024;

    #helloTimer = null;
    #pingTimer = null;
    #clockSamples = [];

    // app: a name for the game and its message format, e.g. 'snake@1'. Both laptops must
    // use the same string, so bump it when the game's messages change. Required, so two
    // different games can never pair by accident.
    constructor({ app } = {}) {
        if (typeof app !== 'string' || !app) throw new Error("PeerLink needs an app name, e.g. new PeerLink({ app: 'my-game@1' })");
        this.app = app;
        this.onopen = null;
        this.onmessage = null;
        // onstatechange(state, reason) reports connection health:
        //   'connected'  link is up (also sent again after recovering from 'unstable')
        //   'unstable'   no contact for ~5 s. It may recover by itself (e.g. a wifi blip)
        //   'closed'     final. reason: 'left' (the other side disconnected or closed
        //                its page), 'lost' (no contact for ~15 s), 'local' (we closed)
        //                or 'mismatch' (the other laptop is running a different app)
        this.onstatechange = null;
        this.onrtt = null;          // onrtt(ms) after each clock sample (about once a second)
        this.state = 'new';
        this.isHost = false;
        this.peerId = null;
        this.rtt = null;
        this.clockReady = false;
        this.peerClockOffset = 0;   // the other side's performance.now() minus ours

        // No STUN/TURN: on a shared LAN the host candidates are all we need.
        this.pc = new RTCPeerConnection({ iceServers: [] });
        // Pre-negotiated channels mean both sides create them identically, with no in-band setup.
        // 'reliable' is ordered and retransmitted. 'fast' never waits for a lost packet, so one
        // dropped packet on wifi can't hold up everything behind it.
        this.channel = this.pc.createDataChannel('reliable', { negotiated: true, id: 0 });
        this.fastChannel = this.pc.createDataChannel('fast', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });

        this.channel.onopen = () => {
            // Say who we are first. Ordered delivery means it reaches the other side before
            // anything the game sends after its own onopen.
            this.#sendRaw(this.channel, { t: PeerLink.#HELLO, id: PeerLink.#pageId, app: this.app });
            this.#helloTimer = setTimeout(() => this.#finish('lost'), 5000);
            this.#maybeOpen();
        };
        this.fastChannel.onopen = () => this.#maybeOpen();
        // A remote channel close arrives almost instantly when the other side closes cleanly.
        const onChannelClose = () => this.#finish(this.#transportDown() ? 'lost' : 'left');
        this.channel.onclose = onChannelClose;
        this.fastChannel.onclose = onChannelClose;
        this.channel.onmessage = (event) => this.#receive(event.data, false);
        this.fastChannel.onmessage = (event) => this.#receive(event.data, true);
        // If a page closes without any goodbye, only WebRTC's consent checks notice:
        // 'disconnected' after ~5 s, 'failed' after ~15 s (measured in Chrome).
        this.pc.onconnectionstatechange = () => {
            const s = this.pc.connectionState;
            if (s === 'disconnected' && this.state === 'connected') this.#setState('unstable');
            else if (s === 'connected' && this.state === 'unstable') this.#setState('connected');
            else if (s === 'failed') this.#finish('lost');
        };
        // Say goodbye when the tab closes or navigates away, so the other side knows at once.
        this.onPageHide = () => this.close();
        window.addEventListener('pagehide', this.onPageHide);
    }

    get isOpen() { return this.state === 'connected' || this.state === 'unstable'; }

    // Bytes queued on the reliable channel and not yet sent. If this keeps growing, the
    // game is sending faster than the wifi can carry.
    get backlog() { return this.channel.bufferedAmount; }

    // A clock in ms that reads the same on both laptops (to within a few ms once
    // clockReady is true). It is the host's performance.now().
    sharedNow() {
        return this.isHost ? performance.now() : performance.now() + this.peerClockOffset;
    }

    #transportDown() {
        return ['disconnected', 'failed', 'closed'].includes(this.pc.connectionState);
    }

    #setState(state, reason) {
        if (this.state === 'closed' || this.state === state) return;
        this.state = state;
        this.onstatechange?.(state, reason);
    }

    #maybeOpen() {
        if (this.state !== 'new' || !this.peerId) return;
        if (this.channel.readyState !== 'open' || this.fastChannel.readyState !== 'open') return;
        clearTimeout(this.#helloTimer);
        const reconnected = this.peerId === PeerLink.#lastPeerId;
        PeerLink.#lastPeerId = this.peerId;
        this.#setState('connected');
        this.#startClock();
        this.onopen?.({ peerId: this.peerId, reconnected });
    }

    #finish(reason) {
        if (this.state === 'closed') return;
        clearTimeout(this.#helloTimer);
        clearInterval(this.#pingTimer);
        this.#setState('closed', reason);
        window.removeEventListener('pagehide', this.onPageHide);
        this.channel.close();
        this.fastChannel.close();
        this.pc.close();
    }

    // Everything from the other laptop passes through here. Only plain objects reach the
    // game, and internal "__" messages never do.
    #receive(raw, fast) {
        if (typeof raw !== 'string' || this.state === 'closed') return;
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return;
        switch (msg.t) {
            case PeerLink.#BYE:
                return this.#finish('left');
            case PeerLink.#HELLO:
                if (this.peerId) return;        // only the first hello counts
                if (msg.app !== this.app) return this.#finish('mismatch');
                if (typeof msg.id === 'string' && /^[0-9a-f]{1,64}$/.test(msg.id)) {
                    this.peerId = msg.id;
                    this.#maybeOpen();
                }
                return;
            case PeerLink.#PING:
                if (Number.isFinite(msg.a)) this.#sendRaw(this.fastChannel, { t: PeerLink.#PONG, a: msg.a, b: performance.now() });
                return;
            case PeerLink.#PONG:
                return this.#onPong(msg);
        }
        if (typeof msg.t === 'string' && msg.t.startsWith('__')) return;
        if (!this.isOpen) return;
        try {
            this.onmessage?.(msg, { fast });
        } catch (err) {
            // A bad message must not take the link down with it.
            console.error('PeerLink: onmessage handler threw', err);
        }
    }

    // Clock sync: ping once a second on the fast channel. Each reply gives a round trip
    // and an estimate of the other clock, assuming the reply was stamped halfway through.
    // The fastest recent round trip had the least queuing delay, so its estimate is used.
    #startClock() {
        const ping = () => this.#sendRaw(this.fastChannel, { t: PeerLink.#PING, a: performance.now() });
        ping();
        this.#pingTimer = setInterval(ping, 1000);
    }

    #onPong({ a, b }) {
        if (!Number.isFinite(a) || !Number.isFinite(b)) return;
        const rtt = performance.now() - a;
        if (rtt < 0 || rtt > 10000) return;
        this.rtt = rtt;
        this.#clockSamples.push({ rtt, offset: b - (a + rtt / 2) });
        if (this.#clockSamples.length > 16) this.#clockSamples.shift();
        const best = this.#clockSamples.reduce((m, s) => (s.rtt < m.rtt ? s : m));
        this.peerClockOffset = best.offset;
        this.clockReady = true;
        this.onrtt?.(rtt);
    }

    // Returns true if the message was queued. False means the link isn't open, the queue
    // is full, or the message was too big; details go to the console. Never throws.
    #sendRaw(channel, obj, backlogLimit = Infinity) {
        if (channel.readyState !== 'open' || channel.bufferedAmount > backlogLimit) return false;
        let text;
        try { text = JSON.stringify(obj); } catch (err) {
            console.warn('PeerLink: message is not JSON-serialisable', err);
            return false;
        }
        const maxBytes = this.pc.sctp?.maxMessageSize || 65536;
        if (text.length * 3 > maxBytes && new TextEncoder().encode(text).length > maxBytes) {
            console.warn(`PeerLink: message is over the ${maxBytes}-byte limit. Split it up.`);
            return false;
        }
        try {
            channel.send(text);
            return true;
        } catch (err) {
            console.warn('PeerLink: send failed', err);
            return false;
        }
    }

    #sendApp(channel, obj, backlogLimit) {
        if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
            console.warn('PeerLink: messages must be plain objects');
            return false;
        }
        if (typeof obj.t === 'string' && obj.t.startsWith('__')) {
            console.warn('PeerLink: message types starting with "__" are reserved');
            return false;
        }
        return this.isOpen && this.#sendRaw(channel, obj, backlogLimit);
    }

    // Reliable and ordered. Use for things that must arrive: moves, scores, chat.
    send(obj) { return this.#sendApp(this.channel, obj, PeerLink.#RELIABLE_BACKLOG); }

    // Unreliable and unordered. Use for frequent snapshots where only the latest matters.
    sendFast(obj) { return this.#sendApp(this.fastChannel, obj, PeerLink.#FAST_BACKLOG); }

    async createOfferCode() {
        this.isHost = true;
        await this.pc.setLocalDescription(await this.pc.createOffer());
        await this.#gatherComplete();
        return PairCodec.encode(this.pc.localDescription.sdp, 'offer');
    }

    async acceptOfferCode(code) {
        const info = PairCodec.decode(code);
        if (info.kind !== 'offer') throw new Error("That's a reply code. Scan the host's code instead.");
        await this.pc.setRemoteDescription({ type: 'offer', sdp: PairCodec.toSdp(info, '0') });
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        await this.#gatherComplete();
        return PairCodec.encode(this.pc.localDescription.sdp, 'answer');
    }

    async acceptAnswerCode(code) {
        const info = PairCodec.decode(code);
        if (info.kind !== 'answer') throw new Error("That's another host's code. Scan the joining laptop's reply.");
        // The answer must use the same media id as our own offer.
        const mid = this.pc.localDescription.sdp.match(/^a=mid:(\S+)/m)?.[1] ?? '0';
        await this.pc.setRemoteDescription({ type: 'answer', sdp: PairCodec.toSdp(info, mid) });
    }

    // Without trickle ICE we wait until all local addresses are gathered before encoding.
    #gatherComplete(timeoutMs = 4000) {
        return new Promise((resolve) => {
            if (this.pc.iceGatheringState === 'complete') return resolve();
            const done = () => {
                clearTimeout(timer);
                this.pc.removeEventListener('icegatheringstatechange', check);
                resolve();
            };
            const check = () => { if (this.pc.iceGatheringState === 'complete') done(); };
            const timer = setTimeout(done, timeoutMs);
            this.pc.addEventListener('icegatheringstatechange', check);
        });
    }

    close() {
        if (this.channel.readyState === 'open') {
            try { this.channel.send(JSON.stringify({ t: PeerLink.#BYE })); } catch { /* closing anyway */ }
        }
        this.#finish('local');
    }
}

// ————— QR rendering and webcam scanning —————
// Draw a QR code (always dark-on-white, with the required quiet zone) onto a canvas.
// Resolves to the number of modules per side.
export const drawQrCode = async (canvas, text) => {
    const qrcode = await loadGlobal('qrcode');
    const qr = qrcode(0, 'L');             // auto size; low error correction is fine for a screen
    qr.addData(text, 'Alphanumeric');
    qr.make();
    const modules = qr.getModuleCount();
    const quiet = 4;
    const scale = Math.max(4, Math.floor(840 / (modules + quiet * 2)));
    const size = (modules + quiet * 2) * scale;
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    for (let r = 0; r < modules; r++) {
        for (let c = 0; c < modules; c++) {
            if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
        }
    }
    return modules;
};

// Reads QR codes from the webcam. onCode is called with each decoded string; it should
// return true to stop scanning.
export class QrScanner {
    constructor(video, onCode) {
        this.video = video;
        this.onCode = onCode;
        this.stream = null;
        this.timer = null;
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
        this.lastText = null;
        this.jsQR = null;
    }

    async start() {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot use the camera');
        this.jsQR = await loadGlobal('jsQR');
        this.stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
        });
        this.video.srcObject = this.stream;
        await this.video.play();
        this.#loop();
    }

    #loop() {
        this.timer = setTimeout(() => {
            if (!this.stream) return;
            const { videoWidth: vw, videoHeight: vh } = this.video;
            if (vw && vh) {
                // Downscale for speed. A screen QR code shown up close still has big modules.
                const scale = Math.min(1, 800 / vw);
                const w = Math.round(vw * scale), h = Math.round(vh * scale);
                this.canvas.width = w; this.canvas.height = h;
                this.ctx.drawImage(this.video, 0, 0, w, h);
                const image = this.ctx.getImageData(0, 0, w, h);
                const result = this.jsQR(image.data, w, h, { inversionAttempts: 'dontInvert' });
                // Skip repeats of a code we already rejected, so the status message stays put.
                if (result?.data && result.data !== this.lastText) {
                    this.lastText = result.data;
                    if (this.onCode(result.data)) return;
                }
            }
            this.#loop();
        }, 120);
    }

    stop() {
        clearTimeout(this.timer);
        this.stream?.getTracks().forEach(t => t.stop());
        this.stream = null;
        this.video.srcObject = null;
    }
}


// =====================================================================
// Pairing UI: Host / Join choice, QR code, camera, paste box, status and
// troubleshooting, ready to drop into any page.
//
// Theme it by setting these CSS custom properties on the container or any ancestor
// (each falls back to something reasonable):
//   --qrp-ink  --qrp-ink-soft  --qrp-surface  --qrp-field  --qrp-line  --qrp-accent
//   --qrp-ok   --qrp-bad       --qrp-mono     --qrp-shadow
// Every element has a data-qrp="…" name, for styling or tests.
// =====================================================================

const PAIRING_CSS = `
.qrp {
    --_ink: var(--qrp-ink, currentColor);
    --_soft: var(--qrp-ink-soft, color-mix(in srgb, currentColor 65%, transparent));
    --_surface: var(--qrp-surface, transparent);
    --_field: var(--qrp-field, transparent);
    --_line: var(--qrp-line, color-mix(in srgb, currentColor 30%, transparent));
    --_accent: var(--qrp-accent, #9A5527);
    --_ok: var(--qrp-ok, #3C7A3F);
    --_bad: var(--qrp-bad, #A33B2B);
    --_mono: var(--qrp-mono, ui-monospace, "SF Mono", Menlo, monospace);
    --_shadow: var(--qrp-shadow, none);
    color: var(--_ink);
}
.qrp *, .qrp *::before, .qrp *::after { box-sizing: border-box; }
.qrp [hidden] { display: none !important; }
.qrp h2 { margin: 0; font-size: 1.25rem; font-weight: 500; display: flex; align-items: center; gap: 10px; }
.qrp p, .qrp ol, .qrp ul { margin: 0; }
.qrp button {
    font-family: var(--_mono); font-size: 0.85rem; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--_ink); background: var(--_surface); border: 1.5px solid var(--_ink);
    padding: 10px 16px; cursor: pointer; border-radius: 2px;
}
.qrp button:hover { border-color: var(--_accent); color: var(--_accent); }
.qrp button:disabled { opacity: 0.4; cursor: not-allowed; border-color: var(--_ink); color: var(--_ink); }
.qrp button.qrp-primary { background: var(--_ink); color: var(--qrp-surface, Canvas); }
.qrp button.qrp-primary:hover { background: var(--_accent); border-color: var(--_accent); }
.qrp-card { background: var(--_surface); border: 1px solid var(--_line); padding: 20px; box-shadow: var(--_shadow); }
.qrp-choices { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px; margin-bottom: 20px; }
.qrp-choices p { color: var(--_soft); margin: 8px 0 16px; }
.qrp-howto ol { padding-left: 1.2em; margin-top: 10px; }
.qrp-howto li { margin-bottom: 6px; }
.qrp-step {
    font-family: var(--_mono); font-size: 0.8rem; width: 26px; height: 26px; border-radius: 50%;
    border: 1.5px solid var(--_accent); color: var(--_accent);
    display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.qrp-hint { color: var(--_soft); margin: 6px 0 14px !important; font-size: 0.97rem; }
.qrp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr)); gap: 20px; }
.qrp-role-guest [data-qrp="scan-card"] { order: -1; }
.qrp-qr-frame {
    background: #FFFFFF; border: 1px solid var(--_line); aspect-ratio: 1; width: 100%; max-width: 420px;
    margin: 0 auto; display: flex; align-items: center; justify-content: center; position: relative;
}
.qrp-qr-frame canvas { width: 100%; height: 100%; image-rendering: pixelated; }
.qrp-placeholder { position: absolute; color: #5C6A5E; font-family: var(--_mono); font-size: 0.85rem; text-align: center; padding: 20px; }
.qrp-code-row { display: flex; gap: 8px; align-items: flex-start; margin-top: 12px; }
.qrp-code {
    flex: 1; font-family: var(--_mono); font-size: 0.78rem; word-break: break-all; line-height: 1.5;
    background: var(--_field); border: 1px dashed var(--_line); padding: 8px; min-height: 2.5em;
}
.qrp-meta { font-family: var(--_mono); font-size: 0.75rem; color: var(--_soft); margin-top: 6px !important; }
.qrp-video-frame { position: relative; background: #111; aspect-ratio: 4 / 3; width: 100%; overflow: hidden; border: 1px solid var(--_line); }
.qrp-video-frame video { width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); display: block; }
.qrp-guide { position: absolute; inset: 12% 22%; border: 2px dashed rgba(255, 255, 255, 0.7); pointer-events: none; }
.qrp-video-frame.qrp-found .qrp-guide { border: 3px solid #84C487; }
.qrp-camera-msg {
    position: absolute; left: 0; right: 0; bottom: 0; padding: 8px 10px; background: rgba(0, 0, 0, 0.6);
    color: #FFF; font-family: var(--_mono); font-size: 0.8rem;
}
.qrp-paste { display: flex; gap: 8px; margin-top: 12px; }
.qrp-paste input {
    flex: 1; min-width: 0; font-family: var(--_mono); font-size: 0.85rem; padding: 9px 10px;
    border: 1.5px solid var(--_line); background: var(--_field); color: var(--_ink); border-radius: 2px;
}
.qrp-status {
    margin-top: 20px; font-family: var(--_mono); font-size: 0.9rem; padding: 12px 14px;
    border-left: 4px solid var(--_accent); background: var(--_surface);
}
.qrp-status.qrp-bad { border-color: var(--_bad); }
.qrp-status ul { margin: 8px 0 0 1.2em; font-family: inherit; }
.qrp-status .qrp-actions { margin-top: 14px; display: flex; gap: 10px; flex-wrap: wrap; }
`;

// Static markup only. Anything that depends on a code or an error is set later as text.
const PAIRING_HTML = `
<section data-qrp="intro">
    <div class="qrp-choices">
        <article class="qrp-card">
            <h2>Host a connection</h2>
            <p>This laptop shows a QR code first, then scans the reply.</p>
            <button type="button" class="qrp-primary" data-qrp="host">Host</button>
        </article>
        <article class="qrp-card">
            <h2>Join a connection</h2>
            <p>This laptop scans the host's code, then shows a reply.</p>
            <button type="button" class="qrp-primary" data-qrp="join">Join</button>
        </article>
    </div>
    <article class="qrp-card qrp-howto" data-qrp="howto">
        <h2>How to pair</h2>
        <ol>
            <li>Open this page on both laptops. Both must be on the <strong>same wifi</strong>.</li>
            <li>Click <strong>Host</strong> on one laptop and <strong>Join</strong> on the other, and allow camera access.</li>
            <li>Sit the laptops facing each other about 30–50&nbsp;cm apart, with screen brightness turned up.</li>
            <li>The joining laptop scans the host's code and shows a reply, and the host scans the reply. Both laptops then connect.</li>
            <li>No working camera? Each code can also be copied and pasted, for example over AirDrop or iMessage.</li>
        </ol>
    </article>
</section>
<section data-qrp="pairing" hidden>
    <div class="qrp-grid">
        <article class="qrp-card" data-qrp="show-card">
            <h2><span class="qrp-step" data-qrp="show-step">1</span><span data-qrp="show-title"></span></h2>
            <p class="qrp-hint" data-qrp="show-hint"></p>
            <div class="qrp-qr-frame">
                <canvas data-qrp="qr" width="1" height="1" aria-label="Pairing QR code"></canvas>
                <div class="qrp-placeholder" data-qrp="placeholder">Preparing…</div>
            </div>
            <div class="qrp-code-row">
                <code class="qrp-code" data-qrp="code">—</code>
                <button type="button" data-qrp="copy" disabled>Copy</button>
            </div>
            <p class="qrp-meta" data-qrp="meta"></p>
        </article>
        <article class="qrp-card" data-qrp="scan-card">
            <h2><span class="qrp-step" data-qrp="scan-step">2</span><span data-qrp="scan-title"></span></h2>
            <p class="qrp-hint" data-qrp="scan-hint"></p>
            <div class="qrp-video-frame" data-qrp="video-frame">
                <video data-qrp="video" playsinline muted></video>
                <div class="qrp-guide"></div>
                <div class="qrp-camera-msg" data-qrp="camera-msg">Starting camera…</div>
            </div>
            <form class="qrp-paste" data-qrp="paste-form">
                <input data-qrp="paste" autocomplete="off" spellcheck="false" placeholder="…or paste their code here" aria-label="Paste pairing code">
                <button type="submit">Use code</button>
            </form>
        </article>
    </div>
    <div class="qrp-status" data-qrp="status" role="status"></div>
</section>
`;

const FAILURE_TIPS_HTML = `
<ul>
    <li>Check both laptops are on the same wifi network, not a guest network.</li>
    <li>Some networks (schools, offices, hotels, guest wifi) block devices from talking to each other.</li>
    <li>A VPN on either laptop can get in the way. Try turning it off.</li>
    <li>On a Mac, check System Settings → Privacy &amp; Security → Local Network, and make sure your browser is switched on.</li>
    <li>If camera access was refused, the laptops have to find each other by hidden <code>.local</code> names, which some networks block. Allowing the camera usually fixes this.</li>
</ul>
<div class="qrp-actions"><button type="button" data-qrp="retry">Try again</button></div>
`;

const ROLE_TEXT = {
    host: {
        showStep: '1', showTitle: 'Show this to the other laptop', showHint: "Turn this screen toward the joining laptop's webcam.",
        scanStep: '2', scanTitle: 'Scan their reply', scanHint: 'When their reply QR code appears, hold it up to this webcam.',
        placeholder: 'Preparing…',
    },
    guest: {
        showStep: '2', showTitle: 'Show your reply', showHint: "Your reply appears here after you scan the host's code.",
        scanStep: '1', scanTitle: "Scan the host's code", scanHint: "Hold this webcam up to the host's QR code.",
        placeholder: "Waiting for the host's code…",
    },
};

let pairingStylesAdded = false;

/**
 * Render the pairing flow into `container` and manage it until a link opens.
 *
 * options:
 *   app           required. Name + version of the app's messages, e.g. 'snake@1'.
 *   onConnected   (link, { peerId, reconnected }) => void. Called once the link is open. The
 *                 PeerLink now belongs to the app: set its handlers inside this callback.
 *   onRoleChosen  optional (role) => void, when Host or Join is clicked.
 *   role          optional 'host' | 'guest' to skip the Host / Join choice.
 *   howTo         default true. Show the "How to pair" instructions under the choice.
 *
 * Returns a controller:
 *   role            'host' | 'guest' | null
 *   start(role?)    (re)start pairing, in the current role by default. Shows the UI again.
 *   chooseRole()    go back to the Host / Join choice
 *   destroy()       stop the camera, remove the UI, and close any link still pairing
 *
 * The UI hides itself (container.hidden = true) once connected and shows itself on start().
 */
export function mountPairing(container, { app, onConnected, onRoleChosen, role: presetRole = null, howTo = true } = {}) {
    if (!(container instanceof Element)) throw new Error('mountPairing needs a container element');
    if (!app) throw new Error("mountPairing needs an app name, e.g. { app: 'my-game@1' }");
    if (typeof onConnected !== 'function') throw new Error('mountPairing needs an onConnected(link, info) callback');

    if (!pairingStylesAdded) {
        const style = document.createElement('style');
        style.dataset.qrp = 'styles';
        style.textContent = PAIRING_CSS;
        document.head.append(style);
        pairingStylesAdded = true;
    }
    const root = document.createElement('div');
    root.className = 'qrp';
    root.innerHTML = PAIRING_HTML;
    container.replaceChildren(root);
    container.hidden = false;
    const ui = (name) => root.querySelector(`[data-qrp="${name}"]`);
    if (!howTo) ui('howto').hidden = true;
    loadQrLibraries().catch(() => { /* reported when actually needed */ });

    let role = null;
    let link = null;               // the link being paired; null once handed to the app
    let scanner = null;
    let busy = false;              // a code has been accepted for this attempt
    let connectTimer = null;
    let run = 0;                   // bumped on every (re)start, so stale async steps bail out

    // Status text always goes in as text, never HTML: error messages can quote parts of a
    // code, and a code can come from anyone who holds a screen up to the camera.
    const setStatus = (message, tone = '', withTips = false) => {
        const el = ui('status');
        el.className = `qrp-status${tone ? ` qrp-${tone}` : ''}`;
        const text = document.createElement(tone === 'bad' ? 'strong' : 'span');
        text.textContent = message;
        el.replaceChildren(text);
        if (withTips) el.insertAdjacentHTML('beforeend', FAILURE_TIPS_HTML);
    };

    const fail = (message) => {
        clearTimeout(connectTimer);
        scanner?.stop();
        setStatus(message, 'bad', true);
    };

    const showCode = async (code) => {
        ui('code').textContent = code.match(/.{1,4}/g).join(' ');
        ui('copy').disabled = false;
        const bytes = PairCodec.decode(code).byteLength;
        const modules = await drawQrCode(ui('qr'), code);
        ui('placeholder').hidden = true;
        ui('meta').textContent = `${code.length} characters · ${bytes} bytes · ${modules}×${modules} QR`;
    };

    const startCamera = async () => {
        scanner?.stop();
        scanner = new QrScanner(ui('video'), handleCode);
        try {
            await scanner.start();
            ui('camera-msg').textContent = 'Looking for a QR code…';
        } catch (err) {
            scanner = null;
            ui('camera-msg').textContent = err.name === 'NotAllowedError'
                ? 'Camera access was blocked. Paste the code below instead.'
                : `Camera unavailable (${err.message}). Paste the code below instead.`;
        }
    };

    // Called with each code seen by the camera or pasted. Returns true once it was accepted.
    const handleCode = (text) => {
        if (busy) return true;
        let info;
        try {
            info = PairCodec.decode(text);
        } catch (err) {
            ui('camera-msg').textContent = `Not a pairing code: ${err.message}`;
            return false;
        }
        const expected = role === 'host' ? 'answer' : 'offer';
        if (info.kind !== expected) {
            ui('camera-msg').textContent = role === 'host'
                ? "That's another host's code. Is the other laptop on Join?"
                : "That's a reply code. Scan the host's QR code instead.";
            return false;
        }
        busy = true;
        ui('video-frame').classList.add('qrp-found');
        ui('camera-msg').textContent = 'Got it ✓';
        scanner?.stop();
        const thisRun = run;
        (role === 'host' ? acceptReply(text, thisRun) : acceptHostCode(text, thisRun))
            .catch(err => { if (thisRun === run) fail(err.message); });
        return true;
    };

    const waitForConnection = (ms) => {
        clearTimeout(connectTimer);
        connectTimer = setTimeout(() => {
            if (link && !link.isOpen) fail("Couldn't connect to the other laptop.");
        }, ms);
    };

    const acceptHostCode = async (code, thisRun) => {
        setStatus('Building a reply…');
        const reply = await link.acceptOfferCode(code);
        if (thisRun !== run) return;
        await showCode(reply);
        setStatus('Now turn this screen toward the host so its webcam can scan your reply.');
        waitForConnection(90000);      // the host needs time to scan the reply
    };

    const acceptReply = async (code, thisRun) => {
        setStatus('Connecting…');
        await link.acceptAnswerCode(code);
        if (thisRun !== run) return;
        waitForConnection(30000);
    };

    const dropLink = () => {
        if (!link) return;
        const old = link;
        link = null;
        old.onopen = old.onmessage = old.onstatechange = old.onrtt = null;
        old.close();
    };

    const setupLink = () => {
        const current = new PeerLink({ app });
        link = current;
        current.onopen = (info) => {
            if (link !== current) return;
            clearTimeout(connectTimer);
            scanner?.stop();
            // Hand over: from here the app owns the link and its handlers.
            current.onopen = current.onstatechange = null;
            link = null;
            container.hidden = true;
            onConnected(current, info);
        };
        current.onstatechange = (state, reason) => {
            if (state !== 'closed' || link !== current) return;
            fail(reason === 'mismatch'
                ? 'The other laptop is running a different game or version of this page.'
                : 'The other laptop closed the connection.');
        };
    };

    const resetPairingUI = () => {
        const text = ROLE_TEXT[role];
        for (const [key, name] of [['showStep', 'show-step'], ['showTitle', 'show-title'], ['showHint', 'show-hint'],
            ['scanStep', 'scan-step'], ['scanTitle', 'scan-title'], ['scanHint', 'scan-hint'], ['placeholder', 'placeholder']]) {
            ui(name).textContent = text[key];
        }
        root.classList.toggle('qrp-role-guest', role === 'guest');
        ui('video-frame').classList.remove('qrp-found');
        ui('camera-msg').textContent = 'Starting camera…';
        ui('paste').value = '';
        ui('qr').width = ui('qr').height = 1;
        ui('placeholder').hidden = false;
        ui('code').textContent = '—';
        ui('copy').disabled = true;
        ui('meta').textContent = '';
    };

    const start = async (newRole = role) => {
        if (newRole !== 'host' && newRole !== 'guest') throw new Error("start() needs a role: 'host' or 'guest'");
        role = newRole;
        const thisRun = ++run;
        clearTimeout(connectTimer);
        busy = false;
        dropLink();
        container.hidden = false;
        ui('intro').hidden = true;
        ui('pairing').hidden = false;
        resetPairingUI();
        setupLink();

        if (role === 'host') {
            setStatus('Starting camera…');
            // Start the camera before creating the offer: once camera permission is granted,
            // browsers share the real LAN IP (shorter code) instead of a hidden .local name.
            await startCamera();
            if (thisRun !== run) return;
            setStatus('Preparing your code…');
            try {
                const code = await link.createOfferCode();
                if (thisRun !== run) return;
                await showCode(code);
                setStatus('Waiting for the other laptop to scan this code and show its reply.');
            } catch (err) {
                if (thisRun === run) fail(err.message);
            }
        } else {
            setStatus("Scan the host's code to begin.");
            await startCamera();
        }
    };

    const chooseRole = () => {
        run++;
        clearTimeout(connectTimer);
        scanner?.stop();
        dropLink();
        role = null;
        container.hidden = false;
        ui('pairing').hidden = true;
        ui('intro').hidden = false;
    };

    // ————— Events —————
    const choose = (chosen) => { onRoleChosen?.(chosen); start(chosen); };
    ui('host').addEventListener('click', () => choose('host'));
    ui('join').addEventListener('click', () => choose('guest'));
    // "Try again" lives inside the status box, which is rebuilt each time.
    ui('status').addEventListener('click', (event) => {
        if (event.target.closest('[data-qrp="retry"]')) start();
    });
    ui('paste-form').addEventListener('submit', (event) => {
        event.preventDefault();
        const text = ui('paste').value.trim();
        if (!text) return;
        try {
            PairCodec.decode(text);
        } catch (err) {
            setStatus(`That code didn't work: ${err.message}`, 'bad');
            return;
        }
        if (!handleCode(text)) setStatus(ui('camera-msg').textContent, 'bad');
    });
    ui('copy').addEventListener('click', async () => {
        const button = ui('copy');
        try {
            await navigator.clipboard.writeText(ui('code').textContent);
            button.textContent = 'Copied';
            setTimeout(() => { button.textContent = 'Copy'; }, 1500);
        } catch {
            // Clipboard access can be blocked. Select the text so it can be copied by hand.
            const range = document.createRange();
            range.selectNodeContents(ui('code'));
            getSelection().removeAllRanges();
            getSelection().addRange(range);
        }
    });

    if (presetRole) start(presetRole);

    return {
        get role() { return role; },
        start,
        chooseRole,
        destroy() {
            run++;
            clearTimeout(connectTimer);
            scanner?.stop();
            dropLink();
            root.remove();
        },
    };
}
