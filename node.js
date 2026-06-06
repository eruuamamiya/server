const axios = require('axios');

async function kirimNotifFavorit(idAnime, judulAnime, episodeBerapa) {
    
    const headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Authorization": "Basic os_v2_app_ct5wfazcvzd73mekb5jmfuzzg4kl66y2qiye4gnnk2jvft6gsgagpasqoa5n2qoa362o2zbpjf7k4j6wqu5ozflvnsxhv2bdunojbvi" 
    };

    const data = {
        app_id: "14fb6283-22ae-47fd-b08a-0f52c2d33937", 
        
        filters: [
            {
                "field": "tag", 
                "key": "fav_" + idAnime, 
                "relation": "=", 
                "value": "true"
            }
        ], 
        
        headings: { "en": "Episode Baru Rilis! 🔥" },
        contents: { "en": `${judulAnime} ${episodeBerapa} udah bisa ditonton di NekoStream!` }
    };

    try {
        const response = await axios.post('https://onesignal.com/api/v1/notifications', data, { headers: headers });
        console.log(`Sukses ngirim notif ${judulAnime} ke user!`);
    } catch (error) {
        console.error("Gagal ngirim notif:", error.response ? error.response.data : error.message);
    }
}
