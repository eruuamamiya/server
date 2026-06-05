const express = require('express');
const puppeteer = require('puppeteer-core');
const { File } = require('megajs');
const cors = require('cors');

const app = express();
const PORT = 3002; // Sesuai dengan port yang kamu buka di router/Cloudflare

// Mengaktifkan CORS agar API bisa diakses dari mana saja
app.use(cors());
app.use(express.json());

// ==========================================
// 1. FUNGSI SCRAPER: VIDHIDE & DESUSTREAM
// ==========================================
async function extractStreamLink(embedUrl) {
    let browser;
    try {
        // Konfigurasi Puppeteer khusus untuk STB / Linux ARM
        browser = await puppeteer.launch({
            executablePath: '/usr/bin/chromium', // Sesuaikan jika path Chromium di STB-mu berbeda (misal: /usr/bin/chromium)
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu'
            ]
        });

        const page = await browser.newPage();
        
        // Memalsukan User-Agent agar tidak diblokir oleh anti-bot Vidhide/Desustream
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

        let directLink = null;

        // Mencegat semua traffic jaringan (Network tab)
        page.on('request', request => {
            const reqUrl = request.url();
            // Filter: Mencari URL yang mengandung .m3u8 (HLS stream) atau .mp4
            if (reqUrl.includes('.m3u8') || reqUrl.includes('.mp4') || reqUrl.includes('/v.mp4')) {
                directLink = reqUrl;
            }
        });

        // Buka URL embed dan tunggu sampai network lumayan stabil
        await page.goto(embedUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        // Tunggu 5 detik ekstra untuk memberi waktu JavaScript player merender link
        await new Promise(resolve => setTimeout(resolve, 5000));

        await browser.close();
        return directLink;

    } catch (error) {
        if (browser) await browser.close();
        console.error("Error scraping Puppeteer:", error.message);
        return null;
    }
}

// ==========================================
// 2. ENDPOINT STREAMING KHUSUS MEGA.NZ
// ==========================================
// Mega tidak di-scrape direct link-nya, melainkan datanya "disedot" dan dialirkan langsung oleh STB
app.get('/api/stream-mega', async (req, res) => {
    const megaUrl = req.query.url;

    if (!megaUrl) {
        return res.status(400).send('URL Mega tidak disediakan');
    }

    try {
        const file = File.fromURL(megaUrl);
        await file.loadAttributes();

        // Mengirimkan header video agar VideoView Android mengenalinya sebagai media
        res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Length': file.size,
            'Accept-Ranges': 'bytes'
        });

        // Mengalirkan (piping) hasil dekripsi video dari Mega langsung ke output klien
        const stream = file.download();
        stream.pipe(res);

    } catch (error) {
        console.error('Error Mega Stream:', error);
        res.status(500).send('Gagal memproses file Mega');
    }
});

// ==========================================
// 3. ENDPOINT UTAMA (ROUTER)
// ==========================================
app.get('/api/get-video', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).json({ success: false, error: 'Parameter url wajib diisi' });
    }

    console.log(`Menerima request untuk: ${targetUrl}`);

    // LOGIKA A: Jika sumbernya Mega.nz
    if (targetUrl.includes('mega.nz')) {
        // Arahkan klien (Sketchware) ke endpoint /api/stream-mega di server ini
        const host = req.get('host'); // Akan mendeteksi api.nekostream.online atau localhost:3002
        const protocol = req.protocol; // http atau https
        
        const localStreamUrl = `${protocol}://${host}/api/stream-mega?url=${encodeURIComponent(targetUrl)}`;
        
        return res.json({ 
            success: true, 
            source: 'mega',
            direct_url: localStreamUrl 
        });
    } 
    
    // LOGIKA B: Jika sumbernya Vidhide atau Desustream
    if (targetUrl.includes('vidhide') || targetUrl.includes('desustream')) {
        const directUrl = await extractStreamLink(targetUrl);
        
        if (directUrl) {
            return res.json({ 
                success: true, 
                source: 'scraper',
                direct_url: directUrl 
            });
        } else {
            return res.status(404).json({ success: false, message: 'Gagal mengekstrak direct link video' });
        }
    }

    // LOGIKA C: Sumber tidak dikenali
    res.status(400).json({ success: false, error: 'Sumber URL tidak didukung API ini' });
});

// Jalankan Server
app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`API Anime Scraper Berjalan di Port: ${PORT}`);
    console.log(`=========================================`);
});
