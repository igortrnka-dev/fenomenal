const $ = s => document.querySelector(s);
const API = window.FEN_CONFIG.API_URL;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* type: text | textarea | number | date | image | select | sizes(csv→array) */
const SCHEMA = {
  members:   { label: 'Crew', cols: ['img', 'name', 'instagram'], fields: [['name', 'Meno', 'text'], ['bio', 'Popis', 'textarea'], ['img', 'Fotka', 'image'], ['instagram', 'Instagram (https://www.instagram.com/…)', 'text'], ['sort', 'Poradie', 'number']] },
  playlists: { label: 'Hudba', cols: ['title', 'sub', 'spotify_id'], fields: [['title', 'Názov', 'text'], ['sub', 'Podtitul', 'text'], ['type', 'Typ', 'select', ['playlist', 'album', 'artist', 'track']], ['spotify_id', 'Spotify ID', 'text'], ['sort', 'Poradie', 'number']] },
  events:    { label: 'Eventy', cols: ['date', 'title', 'city'], fields: [['title', 'Názov', 'text'], ['date', 'Dátum', 'date'], ['venue', 'Miesto', 'text'], ['city', 'Mesto', 'text'], ['ticket_url', 'Odkaz na lístky', 'text']] },
  news:      { label: 'Novinky', cols: ['img', 'date', 'title'], fields: [['title', 'Titulok', 'text'], ['body', 'Text', 'textarea'], ['date', 'Dátum', 'date'], ['img', 'Obrázok', 'image']] },
  products:  { label: 'Shop', cols: ['img', 'name', 'sub', 'price'], fields: [['name', 'Názov', 'text'], ['sub', 'Podtitul', 'text'], ['price', 'Cena (€)', 'number'], ['img', 'Obrázok', 'image'], ['badge', 'Odznak', 'text'], ['sizes', 'Veľkosti (čiarkou)', 'sizes'], ['payment_link', 'Stripe platobný odkaz (záloha)', 'text'], ['sort', 'Poradie', 'number']] },
  orders:    { label: 'Objednávky', orders: true },
  shipping_methods: { label: 'Doprava', cols: ['name', 'price', 'kind'], fields: [['name', 'Názov', 'text'], ['description', 'Popis (napr. doba doručenia)', 'text'], ['price', 'Cena (€)', 'number'], ['kind', 'Typ', 'select', ['address', 'packeta', 'pickup']], ['sort', 'Poradie', 'number']] },
  gallery:   { label: 'Galéria', cols: ['src', 'cap', 'cat'], fields: [['src', 'Obrázok', 'image'], ['cap', 'Popis', 'text'], ['cat', 'Kategória', 'select', ['crew', 'street']], ['sort', 'Poradie', 'number']] }
};
const IMG_COLS = new Set(['img', 'src']);
const KIND = { address: 'Na adresu', packeta: 'Packeta – výdajné miesto', pickup: 'Osobný odber' };
const cell = (c, v) => c === 'kind' ? KIND[v] || v : c === 'price' && v != null ? eur(v) : v;
const STATUS = { pending_payment: 'Čaká na platbu', paid: 'Zaplatená', shipped: 'Odoslaná', done: 'Vybavená', cancelled: 'Zrušená' };
const eur = n => n == null ? '' : `${(+n).toLocaleString('sk-SK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const when = d => new Date(d).toLocaleString('sk-SK', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const total = o => o.amount_total ?? (+o.shipping_method?.price || 0) + (o.items || []).reduce((t, i) => t + (i.amount != null ? +i.amount : (+i.price || 0) * (i.qty ?? i.quantity ?? 1)), 0);

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
// tolerate a pasted list line ("1. fen-…"), spaces or line breaks around the key
const cleanKey = v => (v.match(/fen-[A-Za-z0-9]{7}(?:-[A-Za-z0-9]{7}){3}/) || [v.trim()])[0];
$('#loginForm').onsubmit = async e => {
  e.preventDefault(); $('#loginErr').textContent = '';
  try {
    const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: cleanKey($('#key').value) }) });
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
  $('#addBtn').hidden = !!s.orders;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.k === k));
  document.querySelector('#tabs button.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  rows = await api(`/admin/${k}`); render();
}
function render() {
  const s = SCHEMA[cur];
  if (s.orders) return renderOrders();
  const colLabel = c => (s.fields.find(f => f[0] === c) || [, c])[1].replace(/\s*\(.*\)$/, '');
  $('#table').innerHTML = `<tr>${s.cols.map(c => `<th>${esc(colLabel(c))}</th>`).join('')}<th></th></tr>` + rows.map(r => `
    <tr class="${r.published ? '' : 'off'}">${s.cols.map(c => `<td data-label="${esc(colLabel(c))}" class="${IMG_COLS.has(c) ? 'pic' : ''}">${IMG_COLS.has(c) ? `<img src="${esc(imgSrc(r[c]))}" alt="">` : `<span>${esc(cell(c, r[c]))}</span>`}</td>`).join('')}
    <td class="act"><button class="btn ghost" data-a="pub" data-id="${r.id}">${r.published ? 'Skryť' : 'Zobraziť'}</button><button class="btn ghost" data-a="edit" data-id="${r.id}">Upraviť</button><button class="btn ghost danger" data-a="del" data-id="${r.id}" aria-label="Zmazať">✕</button></td></tr>`).join('');
}
$('#table').onclick = async e => {
  const b = e.target.closest('button'); if (!b) return;
  const r = rows.find(x => x.id == b.dataset.id);
  if (b.dataset.a === 'edit') (SCHEMA[cur].orders ? openOrder : openForm)(r);
  if (b.dataset.a === 'pub') { await api(`/admin/${cur}/${r.id}`, { method: 'PUT', body: JSON.stringify({ published: !r.published }) }); select(cur); }
  if (b.dataset.a === 'del' && confirm('Naozaj zmazať?')) { await api(`/admin/${cur}/${r.id}`, { method: 'DELETE' }); select(cur); }
};
$('#addBtn').onclick = () => openForm(null);

/* ---------- orders ---------- */
function renderOrders() {
  $('#table').innerHTML = `<tr><th>Dátum</th><th>Číslo</th><th>Zákazník</th><th>Suma</th><th>Stav</th><th></th></tr>` + (rows.length ? rows.map(o => `
    <tr class="${o.status === 'cancelled' ? 'void' : ''}"><td data-label="Dátum"><span>${esc(when(o.created_at))}</span></td><td data-label="Číslo"><span>${esc(o.reference || '—')}</span></td>
    <td data-label="Zákazník"><span>${esc(o.name || o.billing?.name || '')}<br><small>${esc(o.email || '')}</small></span></td><td data-label="Suma"><span>${esc(eur(total(o)))}</span></td>
    <td data-label="Stav"><span class="st st-${esc(o.status)}">${esc(STATUS[o.status] || o.status)}</span></td>
    <td class="act"><button class="btn ghost" data-a="edit" data-id="${o.id}">Detail</button><button class="btn ghost danger" data-a="del" data-id="${o.id}" aria-label="Zmazať">✕</button></td></tr>`).join('')
    : `<tr><td colspan="6" class="empty">Zatiaľ žiadne objednávky.</td></tr>`);
}
const addr = a => !a ? '—' : a.packeta_id ? `${esc(a.name || '')}<br>Packeta: ${esc(a.packeta_name)}<br><small>ID miesta ${esc(a.packeta_id)}</small>`
  : a.pickup ? `${esc(a.name || '')}<br>Osobný odber` : [a.name, a.company, a.street, [a.zip, a.city].filter(Boolean).join(' '), a.country, a.email, a.phone].filter(Boolean).map(esc).join('<br>');
function openOrder(o) {
  editing = o;
  $('#form').innerHTML = `<p class="label"><i></i>Objednávka</p><h2 class="form-title">${esc(o.reference || `#${o.id}`)}</h2>
    <p class="muted">${esc(when(o.created_at))}${o.stripe_session_id ? ' · Stripe' : ''}</p>
    <div class="order-items">${(o.items || []).map(i => `<div><span>${(i.qty ?? i.quantity) > 1 ? `${i.qty ?? i.quantity}× ` : ''}${esc(i.name)}${i.size ? ` (${esc(i.size)})` : ''}</span><span>${esc(eur(i.amount ?? i.price))}</span></div>`).join('')}
      ${o.shipping_method ? `<div><span>Doprava: ${esc(o.shipping_method.name)}</span><span>${esc(eur(o.shipping_method.price))}</span></div>` : ''}
      <div class="sum"><span>Spolu</span><span>${esc(eur(total(o)))}</span></div></div>
    <div class="order-addr"><div><p class="label"><i></i>Fakturácia</p><p>${addr(o.billing || { name: o.name, email: o.email, phone: o.phone })}</p></div>
      <div><p class="label"><i></i>Doručenie</p><p>${addr(o.shipping)}</p></div></div>
    ${o.note ? `<div><p class="label"><i></i>Poznámka</p><p>${esc(o.note)}</p></div>` : ''}
    <label>Stav<select name="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === o.status ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <p id="formErr" class="err"></p>
    <div class="row"><button type="button" class="btn ghost" id="cancel">Zavrieť</button><button class="btn" id="save">Uložiť stav</button></div>`;
  $('#dlg').showModal();
  $('#cancel').onclick = () => $('#dlg').close();
}

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
  f.insertAdjacentHTML('afterbegin', `<p class="label"><i></i>${esc(s.label)}</p><h2 class="form-title">${r ? 'Upraviť' : 'Pridať'}</h2>`);
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
  if (SCHEMA[cur].orders) {
    try {
      await api(`/admin/orders/${editing.id}`, { method: 'PUT', body: JSON.stringify({ status: $('#form').elements.status.value }) });
      $('#dlg').close(); select(cur);
    } catch (err) { $('#formErr').textContent = err.message; }
    return;
  }
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
