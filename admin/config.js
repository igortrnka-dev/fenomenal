// URL backendu a verejného webu (kvôli náhľadom obrázkov img/...): lokálne localhost, inak Render
const FEN_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
window.FEN_CONFIG = {
  API_URL: FEN_LOCAL ? 'http://localhost:3000' : 'https://fenomenal-api.onrender.com',
  SITE_URL: FEN_LOCAL ? 'http://localhost:5173' : 'https://www.fenomenal.wtf'
};
