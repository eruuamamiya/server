const express = require('express');
const puppeteer = require('puppeteer-core');
const { File } = require('megajs');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = 3002;

app.use(cors());
app.use(express.json());

// ==========================================
// 1. FUNGSI SCRAPER UTAMA
// ==========================================
async function extractStreamLink(embedUrl) {
    let browser;
    try {
        browser = await puppeteer.launch({
            executablePath: '/usr/bin/chromium',
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });

        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

        let directLink = null;

        page.on('request', request => {
            const reqUrl = request.url();
            if (reqUrl.includes('.m3u8') || reqUrl.includes('.mp4') || reqUrl.includes('/v.mp4')) {
                directLink = reqUrl;
            }
        });

        await page.goto(embedUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        
        // Klik untuk bypass iklan/tombol play
        console.log("Mencoba klik tengah layar...");
        await page.mouse.click(400, 300); 
        await new Promise(resolve => setTimeout(resolve, 1000));
        await page.mouse.click(400, 300);

        await new Promise(resolve => setTimeout(resolve, 8000));
        await browser.close();
        
        return directLink;
    } catch (error) {
        if (browser) await browser.close();
        console.error("Error scraping:", error.message);
        return null;
    }
}

// ==========================================
// 2. ENDPOINT PROXY (MENYEDOT & MENGALIRKAN VIDEO)
// ==========================================
app.get('/api/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("URL tidak ada");

    try {
        const headers = {
            'Referer': 'https://vidhidepro.com/',
            'Origin': 'https://vidhidepro.com',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        };

        // Jika ini adalah file playlist .m3u8, kita harus membedahnya
        if (targetUrl.includes('.m3u8')) {
            const response = await axios.get(targetUrl, { headers });
            let m3u8Data = response.data;

            // Mengambil URL dasar untuk menggabungkan jalur relatif
            const urlParts = targetUrl.split('/');
            urlParts.pop();
            const baseUrl = urlParts.join('/');

            // Menulis ulang semua isi m3u8 agar melewati server STB kita
            const rewritten = m3u8Data.split('\n').map(line => {
                if (line && !line.startsWith('#')) {
                    let absoluteUrl = line.startsWith('http') ? line : `${baseUrl}/${line}`;
                    if(line.startsWith('/')) {
                        absoluteUrl = `${new URL(targetUrl).origin}${line}`;
                    }
                    // Arahkan ke STB
                    return `https://${req.get('host')}/api/proxy?url=${encodeURIComponent(absoluteUrl)}`;
                }
                return line;
            }).join('\n');

            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            return res.send(rewritten);
            
        } else {
            // Jika ini potongan video (.ts) atau .mp4, langsung alirkan!
            const response = await axios({
                method: 'get',
                url: targetUrl,
                headers: headers,
                responseType: 'stream'
            });
            res.setHeader('Content-Type', response.headers['content-type'] || 'video/MP2T');
            response.data.pipe(res);
        }
    } catch (error) {
        console.error('Error di Proxy:', error.message);
        res.status(500).send('Gagal mem-proxy video');
    }
});

// ==========================================
// 3. ENDPOINT STREAMING MEGA.NZ
// ==========================================
app.get('/api/stream-mega', async (req, res) => {
    const megaUrl = req.query.url;
    if (!megaUrl) return res.status(400).send('URL Mega kosong');

    try {
        const file = File.fromURL(megaUrl);
        await file.loadAttributes();
        res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Length': file.size,
            'Accept-Ranges': 'bytes'
        });
        file.download().pipe(res);
    } catch (error) {
        res.status(500).send('Gagal Mega');
    }
});

// ==========================================
// 4. ROUTER UTAMA
// ==========================================
app.get('/api/get-video', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ success: false, error: 'Url kosong' });

    console.log(`[+] Scrape: ${targetUrl}`);
    const host = req.get('host');
    const protocol = req.protocol;

    if (targetUrl.includes('mega.nz')) {
        return res.json({ 
            success: true, 
            source: 'mega',
            direct_url: `${protocol}://${host}/api/stream-mega?url=${encodeURIComponent(targetUrl)}` 
        });
    } 
    
    if (targetUrl.includes('vidhide') || targetUrl.includes('desustream')) {
        const directUrl = await extractStreamLink(targetUrl);
        if (directUrl) {
            // --- KUNCI UTAMA: Kita bungkus link asli dengan Proxy STB kita ---
            const proxyUrl = `${protocol}://${host}/api/proxy?url=${encodeURIComponent(directUrl)}`;
            
            return res.json({ 
                success: true, 
                source: 'scraper',
                direct_url: proxyUrl // Link inilah yang akan diterima Sketchware
            });
        } else {
            return res.status(404).json({ success: false, message: 'Gagal ekstrak link' });
        }
    }

    res.status(400).json({ success: false, error: 'Sumber tidak didukung' });
});

app.listen(PORT, () => console.log(`API Scraper & Proxy STB Berjalan di Port ${PORT}`));
