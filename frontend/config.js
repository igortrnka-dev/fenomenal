// URL backendu: lokálne localhost, inak služba na Renderi (over presnú adresu v Render dashboarde)
const FEN_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
window.FEN_CONFIG = {
  API_URL: FEN_LOCAL ? 'http://localhost:3000' : 'https://fenomenal-api.onrender.com',
  // Packeta API kľúč pre výber výdajného miesta (client.packeta.com → Nastavenia → API). Bez neho sa Packeta neponúka.
  PACKETA_API_KEY: ''
};
