const http = require('http');

const payload = JSON.stringify({
  ids: ['Launch to Riches', 'Le Digger', "Loki's Descendants", "Mr Null's Wicked Wares", 'Queen of Giza'],
  format: 'json'
});

const options = {
  hostname: 'localhost',
  port: 3030,
  path: '/v1/search',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
};

const startTime = Date.now();
let data = '';

const req = http.request(options, (res) => {
  console.log(`\n[${new Date().toISOString()}] STATUS: ${res.statusCode}`);
  
  res.on('data', (chunk) => {
    data += chunk;
    console.log(`[${new Date().toISOString()}] Primljena datoteka... (${data.length} bytes)`);
  });
  
  res.on('end', () => {
    const elapsed = Date.now() - startTime;
    console.log(`\n========== REZULTAT (${Math.round(elapsed/1000)}s) ==========\n`);
    
    try {
      const json = JSON.parse(data);
      console.log(JSON.stringify(json, null, 2));
    } catch (e) {
      console.log(data);
    }
  });
});

req.on('error', (error) => {
  console.error('Greška:', error);
});

console.log(`[${new Date().toISOString()}] Slanjem zahtjeva za 5 igara...\nCzekam do 5 minuta...`);
req.setTimeout(300000); // 5 minuta
req.write(payload);
req.end();
