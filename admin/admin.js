const $ = s => document.querySelector(s);
const API = window.FEN_CONFIG.API_URL;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* type: text | textarea | number | date | image | select | sizes(csv→array) */
const SCHEMA = {
  members:   { label: 'Crew', cols: ['img', 'name', 'bio'], fields: [['name', 'Meno', 'text'], ['bio', 'Popis', 'textarea'], ['img', 'Fotka', 'image'], ['sort', 'Poradie', 'number']] },
  playlists: { label: 'Hudba', cols: ['title', 'sub', 'spotify_id'], fields: [['title', 'Názov', 'text'], ['sub', 'Podtitul', 'text'], ['type', 'Typ', 'select', ['playlist', 'album', 'artist', 'track']], ['spotify_id', 'Spotify ID', 'text'], ['sort', 'Poradie', 'number']] },
  events:    { label: 'Eventy', cols: ['date', 'title', 'city'], fields: [['title', 'Názov', 'text'], ['date', 'Dátum', 'date'], ['venue', 'Miesto', 'text'], ['city', 'Mesto', 'text'], ['ticket_url', 'Odkaz na lístky', 'text']] },
  news:      { label: 'Novinky', cols: ['img', 'date', 'title'], fields: [['title', 'Titulok', 'text'], ['body', 'Text', 'textarea'], ['date', 'Dátum', 'date'], ['img', 'Obrázok', 'image']] },
  products:  { label: 'Shop', cols: ['img', 'name', 'sub', 'price'], fields: [['name', 'Názov', 'text'], ['sub', 'Podtitul', 'text'], ['price', 'Cena (€)', 'number'], ['img', 'Obrázok', 'image'], ['badge', 'Odznak', 'text'], ['sizes', 'Veľkosti (čiarkou)', 'sizes'], ['payment_link', 'Stripe platobný odkaz (záloha)', 'text'], ['sort', 'Poradie', 'number']] },
  gallery:   { label: 'Galéria', cols: ['src', 'cap', 'cat'], fields: [['src', 'Obrázok', 'image'], ['cap', 'Popis', 'text'], ['cat', 'Kategória', 'select', ['crew', 'street']], ['sort', 'Poradie', 'number']] }
};
const IMG_COLS = new Set(['img', 'src']);

let token = sessionStorage.getItem('fen-token'), cur = 'members', rows = [], editing = null;

async function api(path, opts = {}) {
  const headers = { Authorization: `Bearer ${token}`, ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) };
  const r = await fetch(`${API}/api${path}`, { ...opts, headers });
  if (r.status === 401) { logout(); throw new Error('Unauthorized'); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.status === 204 ? null : r.json();
}
const imgSrc = u => !u ? '' : /^https?:/.test(u) ? u : `${(window.FEN_CONFIG.SITE_URL || '')}/${u}`;

/* ---------- auth ---------- */
$('#loginForm').onsubmit = async e => {
  e.preventDefault(); $('#loginErr').textContent = '';
  try {
    const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('#email').value, password: $('#password').value }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error);
    token = d.token; sessionStorage.setItem('fen-token', token); start();
  } catch (err) { $('#loginErr').textContent = err.message; }
};
function logout() { token = null; sessionStorage.removeItem('fen-token'); $('#app').hidden = true; $('#login').hidden = false; }
$('#logout').onclick = logout;

/* ---------- list ---------- */
function start() {
  $('#login').hidden = true; $('#app').hidden = false;
  $('#tabs').innerHTML = Object.entries(SCHEMA).map(([k, v]) => `<button data-k="${k}">${v.label}</button>`).join('');
  select(cur);
}
$('#tabs').onclick = e => { const k = e.target.dataset.k; if (k) select(k); };
async function select(k) {
  cur = k; const s = SCHEMA[k];
  $('#title').textContent = s.label;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.k === k));
  rows = await api(`/admin/${k}`); render();
}
function render() {
  const s = SCHEMA[cur];
  $('#table').innerHTML = `<tr>${s.cols.map(c => `<th>${c}</th>`).join('')}<th></th></tr>` + rows.map(r => `
    <tr class="${r.published ? '' : 'off'}">${s.cols.map(c => `<td>${IMG_COLS.has(c) ? `<img src="${esc(imgSrc(r[c]))}" alt="">` : esc(r[c])}</td>`).join('')}
    <td class="act"><button class="btn ghost" data-a="pub" data-id="${r.id}">${r.published ? 'Skryť' : 'Zobraziť'}</button><button class="btn ghost" data-a="edit" data-id="${r.id}">Upraviť</button><button class="btn ghost" data-a="del" data-id="${r.id}">✕</button></td></tr>`).join('');
}
$('#table').onclick = async e => {
  const b = e.target.closest('button'); if (!b) return;
  const r = rows.find(x => x.id == b.dataset.id);
  if (b.dataset.a === 'edit') openForm(r);
  if (b.dataset.a === 'pub') { await api(`/admin/${cur}/${r.id}`, { method: 'PUT', body: JSON.stringify({ published: !r.published }) }); select(cur); }
  if (b.dataset.a === 'del' && confirm('Naozaj zmazať?')) { await api(`/admin/${cur}/${r.id}`, { method: 'DELETE' }); select(cur); }
};
$('#addBtn').onclick = () => openForm(null);

/* ---------- form ---------- */
function openForm(r) {
  editing = r; const s = SCHEMA[cur], f = $('#form');
  f.innerHTML = s.fields.map(([k, label, type, opts]) => {
    const v = r ? r[k] : '';
    const input = type === 'textarea' ? `<textarea name="${k}" rows="4">${esc(v)}</textarea>`
      : type === 'select' ? `<select name="${k}">${opts.map(o => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`
      : type === 'image' ? `<div class="upl"><img src="${esc(imgSrc(v))}" alt=""><input type="file" accept="image/*" data-up="${k}"><input type="hidden" name="${k}" value="${esc(v)}"></div>`
      : type === 'sizes' ? `<input name="${k}" value="${esc((v || ['S', 'M', 'L', 'XL']).join(','))}">`
      : `<input name="${k}" type="${type}" value="${esc(v)}">`;
    return `<label>${label}${input}</label>`;
  }).join('') + `<label class="chk"><input type="checkbox" name="published" ${!r || r.published ? 'checked' : ''}> Zverejnené</label>
    <p id="formErr" class="err"></p>
    <div class="row"><button type="button" class="btn ghost" id="cancel">Zrušiť</button><button class="btn" id="save">Uložiť</button></div>`;
  $('#dlg').showModal();
  $('#cancel').onclick = () => $('#dlg').close();
}
$('#form').addEventListener('change', async e => {
  const k = e.target.dataset.up; if (!k) return;
  const fd = new FormData(); fd.append('file', e.target.files[0]);
  try {
    const { url } = await api('/admin/upload', { method: 'POST', body: fd });
    $('#form').elements[k].value = url; e.target.previousElementSibling.src = url;
  } catch (err) { $('#formErr').textContent = err.message; }
});
$('#form').onsubmit = async e => {
  e.preventDefault();
  const s = SCHEMA[cur], body = { published: $('#form').elements.published.checked };
  for (const [k, , type] of s.fields) {
    let v = $('#form').elements[k].value;
    if (type === 'number') v = v === '' ? null : +v;
    else if (type === 'sizes') v = v.split(',').map(x => x.trim()).filter(Boolean);
    else if (v === '') v = null;
    body[k] = v;
  }
  try {
    await api(editing ? `/admin/${cur}/${editing.id}` : `/admin/${cur}`, { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) });
    $('#dlg').close(); select(cur);
  } catch (err) { $('#formErr').textContent = err.message; }
};

if (token) start();
