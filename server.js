const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const pm2 = require('pm2');
const os = require('os');
const { execSync, spawn } = require('child_process');
const path = require('path');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = 1111;

// ==========================================
// KONFIGURASI SISTEM
// ==========================================
const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin123';
const JWT_SECRET = 'rahasia-super-panel-cpanel-clone';

// Kredensial Cloudflare Zero Trust
const CF_ACCOUNT_ID = '6b219b9ca85b3a5faea24c1dc03af06a';
const CF_API_TOKEN = 'cfut_4b11NWYM3CwGyE4002lvSssQ4zl4jz92k88E385I0eab7983';
const CF_TUNNEL_IDS = [
    '3696ff2c-d48f-410b-850a-285125ca0b1d',
    '29e87c90-b790-4d65-8351-cb166be8546f'
];

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// MIDDLEWARE AUTHENTICATION
// ==========================================
function authenticateToken(req, res, next) {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Akses ditolak!" });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "Token tidak valid!" });
        req.user = user;
        next();
    });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, req.body.targetPath || os.homedir()),
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage: storage });

// ==========================================
// AUTO-DISCOVERY CLOUDFLARE
// ==========================================
async function getCloudflareRouting() {
    let allRoutes = [];
    for (const tunnelId of CF_TUNNEL_IDS) {
        try {
            const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${tunnelId}/configurations`, {
                method: 'GET',
                headers: { 'Authorization': `Bearer ${CF_API_TOKEN}`, 'Content-Type': 'application/json' }
            });
            if (!response.ok) continue;
            const data = await response.json();
            if (data.success && data.result?.config?.ingress) {
                const routes = data.result.config.ingress
                    .filter(rule => rule.hostname && rule.service)
                    .map(rule => {
                        const portMatch = rule.service.match(/:(\d+)$/);
                        return { domain: rule.hostname, port: portMatch ? parseInt(portMatch[1]) : null };
                    });
                allRoutes = allRoutes.concat(routes);
            }
        } catch (error) { console.error(`Gagal narik API Tunnel ${tunnelId}:`, error); }
    }
    return allRoutes;
}

function getPortFromPID(pid) {
    if (!pid) return null;
    try {
        const match = execSync(`ss -lntp | grep ${pid}`).toString().match(/:(\d+)\s+/);
        return match ? parseInt(match[1]) : null;
    } catch (e) { return null; }
}

// ==========================================
// ENDPOINT API
// ==========================================
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        res.json({ success: true, token: jwt.sign({ user: username }, JWT_SECRET, { expiresIn: '24h' }) });
    } else res.status(401).json({ success: false, error: "Username/Password salah!" });
});

app.get('/api/websites', authenticateToken, async (req, res) => {
    // Tarik rute murni HANYA dari Cloudflare
    const cfRoutes = await getCloudflareRouting();
    
    pm2.connect((err) => {
        if (err) return res.status(500).json({ error: "PM2 Gagal" });
        pm2.list((err, pm2List) => {
            const pm2Apps = err ? [] : pm2List;

            // Loop mutlak berdasarkan list Cloudflare, BUKAN PM2
            const dashboardData = cfRoutes.map(route => {
                // Cocokkan port dari CF dengan port yang lagi jalan di PM2
                const matchedApp = pm2Apps.find(app => {
                    const appPort = app.pm2_env.WEB_PORT || getPortFromPID(app.pid);
                    return appPort == route.port;
                });

                return {
                    name: matchedApp ? matchedApp.name : route.domain.split('.')[0],
                    domain: route.domain,
                    port: route.port || '-',
                    status: matchedApp ? matchedApp.pm2_env.status : 'offline',
                    pm_id: matchedApp ? matchedApp.pm_id : null
                };
            });

            res.json(dashboardData);
        });
    });
});

app.post('/api/action', authenticateToken, (req, res) => {
    const { action, pm_id } = req.body;
    pm2.connect(() => {
        if (action === 'start') pm2.start(pm_id, (err) => res.json({ status: err ? 'error' : 'success' }));
        else if (action === 'stop') pm2.stop(pm_id, (err) => res.json({ status: err ? 'error' : 'success' }));
        else if (action === 'restart') pm2.restart(pm_id, (err) => res.json({ status: err ? 'error' : 'success' }));
    });
});

app.post('/api/apps/create', authenticateToken, (req, res) => {
    const { appName, scriptPath, domain, port } = req.body;
    pm2.connect(() => {
        pm2.start({ script: scriptPath, name: appName, env: { WEB_PORT: port, WEB_DOMAIN: domain } }, (err) => {
            if (err) return res.status(500).json({ error: err.message });
            pm2.save(); res.json({ success: true });
        });
    });
});

// File Manager
app.post('/api/files', authenticateToken, (req, res) => {
    const targetPath = req.body.path || os.homedir();
    try {
        const items = fs.readdirSync(targetPath, { withFileTypes: true }).map(item => {
            const isDir = item.isDirectory(); let size = 0;
            if (!isDir) try { size = fs.statSync(path.join(targetPath, item.name)).size; } catch (e) {}
            return { name: item.name, isDirectory: isDir, size: (size / 1024).toFixed(1) + ' KB' };
        });
        items.sort((a, b) => (b.isDirectory === a.isDirectory) ? a.name.localeCompare(b.name) : (b.isDirectory ? 1 : -1));
        res.json({ success: true, currentPath: targetPath, items });
    } catch (error) { res.status(500).json({ error: "Folder tidak ditemukan/Akses ditolak" }); }
});
app.post('/api/files/upload', authenticateToken, upload.single('file'), (req, res) => res.json({ success: true }));
app.post('/api/files/delete', authenticateToken, (req, res) => {
    try { fs.statSync(req.body.path).isDirectory() ? fs.rmSync(req.body.path, { recursive: true, force: true }) : fs.unlinkSync(req.body.path); res.json({ success: true }); } catch (e) { res.status(500).json({ error: "Error" }); }
});

// Download & Backup API
app.get('/api/download', (req, res) => jwt.verify(req.query.token, JWT_SECRET, (err) => err ? res.status(403).send("Error") : res.download(req.query.path)));
app.get('/api/backup', (req, res) => {
    jwt.verify(req.query.token, JWT_SECRET, (err) => {
        if (err) return res.status(403).send("Error");
        const backupPath = path.join(os.tmpdir(), `backup-${Date.now()}.tar.gz`);
        execSync(`tar -czf ${backupPath} -C ${req.query.path || os.homedir()} .`);
        res.download(backupPath, () => fs.unlinkSync(backupPath));
    });
});

// STATISTIK SERVER
app.get('/api/server-stats', authenticateToken, (req, res) => {
    const totalRam = os.totalmem(), freeRam = os.freemem(), usedRam = totalRam - freeRam;
    let diskTotal = '0G', diskUsed = '0G', diskPercent = '0';
    try { 
        const df = execSync("df -h / | awk 'NR==2 {print $2, $3, $5}'").toString().trim().split(/\s+/); 
        diskTotal = df[0]; diskUsed = df[1]; diskPercent = df[2].replace('%', ''); 
    } catch (e) {}

    let serverIp = '127.0.0.1';
    try { serverIp = execSync('curl -s ifconfig.me').toString().trim(); } catch (e) {}
    const cpuLoad = Math.round((os.loadavg()[0] / os.cpus().length) * 100) || 0;

    const uptime = os.uptime();
    const d = Math.floor(uptime / (3600 * 24));
    const h = Math.floor((uptime % (3600 * 24)) / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const uptimeStr = `${d} days ${h}h ${m}m`;

    let cpuTemp = 'N/A';
    try {
        const tempRaw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8');
        cpuTemp = (parseInt(tempRaw) / 1000).toFixed(1) + ' °C'; 
    } catch (e) {}

    let osVersion = os.version();
    try {
        const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
        const match = osRelease.match(/PRETTY_NAME="([^"]+)"/);
        if (match) osVersion = match[1];
    } catch (e) {}

    res.json({
        general: { user: os.userInfo().username, ip: serverIp, os: osVersion, uptime: uptimeStr },
        stats: { cpu: cpuLoad, temp: cpuTemp, ram: { used: (usedRam / 1024 ** 3).toFixed(2), total: (totalRam / 1024 ** 3).toFixed(2), percent: Math.round((usedRam / totalRam) * 100) }, disk: { used: diskUsed, total: diskTotal, percent: diskPercent } }
    });
});

// ==========================================
// SOCKET.IO WEB TERMINAL
// ==========================================
io.use((socket, next) => {
    jwt.verify(socket.handshake.auth.token, JWT_SECRET, (err, user) => err ? next(new Error('Auth Error')) : (socket.user = user, next()));
});

io.on('connection', (socket) => {
    const shell = spawn('bash', [], { cwd: os.homedir(), env: process.env });
    shell.stdout.on('data', (data) => socket.emit('terminal.out', data.toString('utf-8')));
    shell.stderr.on('data', (data) => socket.emit('terminal.out', data.toString('utf-8')));
    socket.on('terminal.in', (input) => shell.stdin.write(input));
    socket.on('disconnect', () => shell.kill());
});

server.listen(PORT, () => { console.log(`🚀 Panel Aktif di Port ${PORT}`); });
                                                                         
