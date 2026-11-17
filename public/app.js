// 輕注音詞庫：單頁網頁。所有資料都透過 /api 取得，登入後依角色顯示不同功能。
// 畫面：① 查詢詞庫 ② 待審新詞 ③ 我的 ④ 審核台 ⑤ 版本 ⑥ 回報處理 ⑦ 分析

// ==================== 小工具 ====================

/** 建立元素。文字一律用 textContent 放進去，不用 innerHTML，避免 XSS */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status, code: data.code });
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.className = `toast${isError ? ' error' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 5000 : 2500);
}

/** 執行一個動作；失敗就把資料庫給的訊息（例如「名額已滿」）顯示出來 */
async function attempt(fn, success) {
  try {
    const result = await fn();
    if (success) toast(success);
    return result;
  } catch (e) {
    toast(e.message, true);
    if (e.status === 401) login();
    return undefined;
  }
}

const fmt = (n) => Number(n ?? 0).toLocaleString('zh-TW');
const date = (t) => (t ? new Date(t).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' }) : '');
const STATUS = { pending: '待審', approved: '加入', rejected: '不收', blocked: '封鎖', staged: '草稿中', active: '上線', retired: '停用' };
const ACTION = { add: '新增', remove: '停用', reweight: '調詞頻' };

// ==================== 登入與導覽 ====================

let user = null;

const PAGES = [
  { path: 'search', name: '查詢詞庫', view: searchView },
  { path: 'candidates', name: '待審新詞', view: candidatesView },
  { path: 'me', name: '我的', view: meView, login: true },
  { path: 'review', name: '審核台', view: reviewView, editor: true },
  { path: 'releases', name: '版本', view: releasesView, editor: true },
  { path: 'reports', name: '回報處理', view: reportsView, editor: true },
  { path: 'analytics', name: '分析', view: analyticsView, editor: true },
];

function renderChrome(current) {
  const visible = PAGES.filter((p) => (!p.login || user) && (!p.editor || user?.role === 'editor'));
  const links = [];
  visible.forEach((p, i) => {
    if (p.editor && !visible[i - 1]?.editor) links.push(h('span', { class: 'sep' }));
    links.push(h('a', { href: `#/${p.path}`, class: p.path === current ? 'on' : '' }, p.name));
  });
  document.getElementById('nav').replaceChildren(...links);
  document.getElementById('account').replaceChildren(...(user
    ? [h('span', {}, user.display_name, user.role === 'editor' ? '（編輯）' : ''),
       h('button', { class: 'small', onclick: logout }, '登出')]
    : [h('button', { class: 'small primary', onclick: login }, '登入')]));
}

function login() {
  const dialog = document.getElementById('login');
  const form = dialog.querySelector('form');
  const error = form.querySelector('.error');
  error.hidden = true;
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      ({ user } = await api('/login', { method: 'POST', body: Object.fromEntries(new FormData(form)) }));
      dialog.close();
      route();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  };
  form.querySelector('[value=cancel]').onclick = () => dialog.close();
  dialog.showModal();
}

async function logout() {
  await api('/logout', { method: 'POST' });
  user = null;
  location.hash = '#/search';
  route();
}

let cleanup = null;
async function route() {
  cleanup?.();
  cleanup = null;
  const path = location.hash.replace(/^#\//, '').split('?')[0] || 'search';
  const page = PAGES.find((p) => p.path === path) ?? PAGES[0];
  renderChrome(page.path);
  const view = document.getElementById('view');
  if ((page.login && !user) || (page.editor && user?.role !== 'editor')) {
    view.replaceChildren(h('div', { class: 'panel empty' }, page.editor ? '這一頁只有編輯能使用，請用編輯帳號登入。' : '請先登入。'));
    return;
  }
  view.replaceChildren();
  cleanup = (await page.view(view)) ?? null;
}

// ==================== ① 查詢詞庫 ====================

function searchView(root) {
  const modes = { initials: '首字注音', bopomofo: '完整注音', text: '詞' };
  const placeholders = { initials: '例：ㄍㄌㄑ', bopomofo: '例：ㄋㄧˇ ㄏㄠˇ', text: '例：旅' };
  let mode = 'initials';
  const input = h('input', { class: 'grow', autofocus: true });
  const tabs = h('div', { class: 'tabs' });
  const results = h('div');
  const side = h('div', { class: 'side' });

  const drawTabs = () => {
    tabs.replaceChildren(...Object.entries(modes).map(([k, v]) =>
      h('button', { class: k === mode ? 'on' : '', onclick: () => { mode = k; drawTabs(); search(); } }, v)));
    input.placeholder = placeholders[mode];
  };
  let timer;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 250); });

  async function search() {
    const q = input.value.trim();
    if (!q) return results.replaceChildren(h('div', { class: 'empty' }, '輸入注音或詞開始查詢'));
    const { results: rows } = await api(`/lexicon?mode=${mode}&q=${encodeURIComponent(q)}`);
    results.replaceChildren(rows.length === 0 ? h('div', { class: 'empty' }, '詞庫裡沒有符合的詞') : h('table', {},
      h('tr', {}, h('th', {}, '詞'), h('th', {}, '讀音'), h('th', { class: 'num' }, '詞頻'), h('th', {}, '來源')),
      rows.map((r) => h('tr', { class: 'click', onclick: () => showEntry(r.entry_id) },
        h('td', {}, r.text), h('td', { class: 'bopomofo' }, r.bopomofo),
        h('td', { class: 'num' }, fmt(r.frequency)), h('td', { class: 'muted' }, r.source)))));
  }

  async function showEntry(id) {
    const { entry, next, prev, history } = await api(`/lexicon/${id}`);
    const words = (list) => list.length ? list.map((w) => h('span', { class: 'chip' }, w.text)) : h('span', { class: 'muted' }, '無');
    const kind = h('select', {}, h('option', { value: 'wrong_reading' }, '讀音錯誤'),
      h('option', { value: 'not_word' }, '不是一個詞'), h('option', { value: 'offensive' }, '冒犯性內容'));
    const note = h('input', { placeholder: '補充說明（選填）', maxlength: 200 });
    const editor = user?.role === 'editor' && entry.status === 'active';
    const freq = h('input', { type: 'number', min: 0, value: entry.frequency, style: 'width:110px' });
    side.replaceChildren(h('div', { class: 'panel stack' },
      h('div', {}, h('div', { class: 'big' }, entry.text), h('div', { class: 'bopomofo muted' }, entry.bopomofo)),
      h('div', { class: 'row' }, h('span', { class: 'chip ok' }, STATUS[entry.status]),
        h('span', { class: 'chip' }, entry.source), h('span', { class: 'chip' }, `詞頻 ${fmt(entry.frequency)}`),
        h('span', { class: 'chip' }, `語料 ${fmt(entry.corpus_count)} 次`)),
      h('div', {}, h('h2', {}, '常接在後面'), h('div', { class: 'row' }, words(next))),
      h('div', {}, h('h2', {}, '常出現在前面'), h('div', { class: 'row' }, words(prev))),
      history.length > 0 && h('div', {}, h('h2', {}, '版本紀錄'), history.map((c) =>
        h('div', { class: 'muted' }, `${c.version}　${ACTION[c.action]}`,
          c.action === 'reweight' ? `　${c.old_frequency} → ${c.new_frequency}` : '', c.status === 'draft' ? '（草稿）' : ''))),
      editor && h('div', {}, h('h2', {}, '維護（寫進草稿版本）'), h('div', { class: 'row' }, freq,
        h('button', { onclick: () => change('reweight') }, '調詞頻'),
        h('button', { class: 'danger', onclick: () => change('remove') }, '停用'))),
      user && h('div', {}, h('h2', {}, '回報這個詞條'), h('div', { class: 'stack' }, kind, note,
        h('button', { onclick: report }, '送出回報'))),
      !user && h('p', { class: 'muted' }, '登入後可以回報錯誤。')));

    async function report() {
      await attempt(() => api(`/lexicon/${id}/reports`, { method: 'POST', body: { kind: kind.value, note: note.value } }),
        '已送出回報，謝謝！');
    }
    async function change(action) {
      const ok = await attempt(() => api(`/lexicon/${id}/change`, {
        method: 'POST', body: { action, new_frequency: action === 'reweight' ? Number(freq.value) : null, row_version: entry.row_version },
      }), action === 'remove' ? '已排入草稿版本：停用' : '已排入草稿版本：調詞頻');
      if (ok) showEntry(id);
    }
  }

  drawTabs();
  root.append(h('h1', {}, '查詢詞庫'), h('p', { class: 'sub' }, '用首字注音、完整注音或詞的一部分，查正式詞庫裡上線中的詞條。'),
    h('div', { class: 'split' }, h('div', { class: 'stack' },
      h('div', { class: 'panel row' }, tabs, input), h('div', { class: 'panel' }, results)), side));
  search();
}

// ==================== ② 待審新詞 ====================

function candidateTable(rows, { onPick, selected, voting }) {
  return h('table', {},
    h('tr', {}, h('th', {}, '詞'), h('th', { class: 'num' }, '裝置（綁定）'), h('th', { class: 'num' }, '使用次數'),
      h('th', { class: 'num' }, '淨票'), voting && h('th', {}, '投票')),
    rows.map((r) => h('tr', { class: `${onPick ? 'click' : ''} ${selected === r.word_id ? 'sel' : ''}`, onclick: onPick && (() => onPick(r)) },
      h('td', {}, h('strong', {}, r.text)),
      h('td', { class: 'num' }, `${fmt(r.devices)}（${fmt(r.bound_devices)}）`),
      h('td', { class: 'num' }, fmt(r.uses)),
      h('td', { class: 'num' }, r.net_votes > 0 ? `+${fmt(r.net_votes)}` : fmt(r.net_votes)),
      voting && h('td', {}, voteButtons(r)))));
}

function voteButtons(r) {
  const box = h('span', { class: 'vote' });
  const draw = () => box.replaceChildren(
    h('button', { class: r.my_vote === 1 ? 'on' : '', onclick: (e) => { e.stopPropagation(); cast(r.my_vote === 1 ? 0 : 1); } }, '▲ 讚'),
    h('button', { class: r.my_vote === -1 ? 'on down' : '', onclick: (e) => { e.stopPropagation(); cast(r.my_vote === -1 ? 0 : -1); } }, '▼'));
  async function cast(value) {
    if (!user) return login();
    const res = await attempt(() => api(`/candidates/${r.word_id}/vote`, { method: 'POST', body: { value } }));
    if (res) { Object.assign(r, res); draw(); }
  }
  draw();
  return box;
}

function candidatesView(root) {
  const sorts = { devices: '最多裝置', votes: '最多票', uses: '最常用', recent: '最近' };
  let sort = 'devices';
  let rows = [];
  const tabs = h('div', { class: 'tabs' });
  const list = h('div');
  const more = h('button', { onclick: () => load(true) }, '載入更多');

  const drawTabs = () => tabs.replaceChildren(...Object.entries(sorts).map(([k, v]) =>
    h('button', { class: k === sort ? 'on' : '', onclick: () => { sort = k; drawTabs(); load(); } }, v)));

  async function load(append = false) {
    const { candidates } = await api(`/candidates?sort=${sort}&limit=50&offset=${append ? rows.length : 0}`);
    rows = append ? rows.concat(candidates) : candidates;
    list.replaceChildren(candidateTable(rows, { voting: true }));
  }

  drawTabs();
  root.append(h('h1', {}, '待審新詞'), h('p', { class: 'sub' }, '輸入法使用者打出、但詞庫還沒有的詞。投票幫編輯決定哪些詞值得收進下一版。'),
    h('div', { class: 'panel stack' }, tabs, list, h('div', { class: 'row end' }, more)));
  load();
}

// ==================== ④ 審核台 ====================

async function quotaBar() {
  const box = h('div', { class: 'panel quota' });
  async function refresh() {
    const { draft } = await api('/review/draft').catch(() => ({ draft: undefined }));
    if (draft === undefined) return;
    box.replaceChildren(...(draft
      ? [h('div', {}, h('div', { class: 'muted' }, '草稿版本'), h('div', { class: 'big' }, draft.version)),
         h('div', { class: `bar ${draft.used >= draft.max_new_words ? 'full' : ''}` },
           h('div', { style: `width:${(100 * draft.used) / draft.max_new_words}%` })),
         h('div', { class: 'num' }, h('div', { class: 'muted' }, '新詞名額'), h('div', { class: 'big' }, `${draft.used} / ${draft.max_new_words}`))]
      : [h('div', { class: 'grow' }, '目前沒有草稿版本，請到「版本」建立下一版。')]));
  }
  await refresh();
  return { box, refresh };
}

async function reviewView(root) {
  const quota = await quotaBar();
  let rows = [];
  let picked = null;
  const list = h('div');
  const side = h('div', { class: 'side' }, h('div', { class: 'panel empty' }, '從左邊選一個詞開始審核'));

  async function load() {
    ({ candidates: rows } = await api('/candidates?sort=devices&limit=30'));
    list.replaceChildren(candidateTable(rows, { onPick: pick, selected: picked }));
  }

  async function pick(row) {
    picked = row.word_id;
    list.replaceChildren(candidateTable(rows, { onPick: pick, selected: picked }));
    const d = await api(`/review/${row.word_id}`);
    const readings = h('div', { class: 'stack' });
    const addReading = (bopomofo = '') => {
      const line = h('div', { class: 'reading' },
        h('input', { class: 'bopomofo', value: bopomofo, placeholder: '完整讀音，音節以空格分隔' }),
        h('input', { type: 'number', min: 0, value: 1000, title: '詞頻' }),
        h('button', { class: 'ghost small', onclick: () => line.remove() }, '✕'));
      readings.append(line);
    };
    addReading(d.suggestions[0] ?? '');
    const decide = async (status) => {
      if (await attempt(() => api(`/review/${row.word_id}/decide`, { method: 'POST', body: { row_version: d.word.row_version, status } }),
        `已${STATUS[status]}「${d.word.text}」`) !== undefined) done();
    };
    const approve = async () => {
      const chosen = [...readings.querySelectorAll('.reading')].map((l) => {
        const [b, f] = l.querySelectorAll('input');
        return { bopomofo: b.value, frequency: Number(f.value) };
      }).filter((r) => r.bopomofo.trim());
      const res = await attempt(() => api(`/review/${row.word_id}/approve`, { method: 'POST', body: { row_version: d.word.row_version, readings: chosen } }));
      if (res) { toast(`已把「${d.word.text}」加入 ${res.version}`); done(); }
    };
    function done() {
      picked = null;
      side.replaceChildren(h('div', { class: 'panel empty' }, '從左邊選一個詞開始審核'));
      load();
      quota.refresh();
    }
    side.replaceChildren(h('div', { class: 'panel stack' },
      h('div', { class: 'row' }, h('span', { class: 'big grow' }, d.word.text), h('span', { class: 'chip', title: '樂觀鎖用的版本號' }, `row_version ${d.word.row_version}`)),
      h('div', {}, h('h2', {}, '使用者怎麼打'), h('table', {}, d.typed.map((t) =>
        h('tr', {}, h('td', { class: 'bopomofo' }, t.typed), h('td', { class: 'num muted' }, `${fmt(t.devices)} 台`))))),
      h('div', {}, h('h2', {}, '讀音與詞頻'),
        d.suggestions.length > 0 && h('div', { class: 'suggest', style: 'margin-bottom:10px' },
          h('span', { class: 'muted' }, '建議：'), d.suggestions.map((s) => h('button', { onclick: () => addReading(s) }, s))),
        readings,
        h('button', { class: 'ghost small', onclick: () => addReading() }, '＋ 再加一個讀音')),
      d.history.length > 0 && h('div', {}, h('h2', {}, '審核歷程（MongoDB）'), d.history.map((x) =>
        h('div', { class: 'muted' }, `${date(x.ts)}　${STATUS[x.from]} → ${STATUS[x.to]}`))),
      h('div', { class: 'row end' },
        h('button', { class: 'danger', onclick: () => decide('blocked') }, '封鎖'),
        h('button', { class: 'warn', onclick: () => decide('rejected') }, '不收'),
        h('button', { class: 'primary', onclick: approve }, '加入草稿版本'))));
  }

  root.append(h('h1', {}, '審核台'), h('p', { class: 'sub' }, '依綁定帳號的裝置數排序。加入的詞放進草稿版本，發布後使用者才打得到。'),
    h('div', { class: 'stack' }, quota.box, h('div', { class: 'split' }, h('div', { class: 'panel' }, list), side)));
  await load();
  // 每 5 秒更新名額，另一位編輯加了詞這裡也看得到
  const timer = setInterval(quota.refresh, 5000);
  return () => clearInterval(timer);
}

// ==================== ⑤ 版本 ====================

async function releasesView(root) {
  const detail = h('div');
  const { releases } = await api('/releases');
  const draft = releases.find((r) => r.status === 'draft');
  const latest = releases[0];
  const nextVersion = latest ? `${Number(latest.version.split('.')[0]) + 1}.0` : '1.0';

  async function show(version) {
    const { release, changes } = await api(`/releases/${version}`);
    const isDraft = release.status === 'draft';
    detail.replaceChildren(h('div', { class: 'panel stack' },
      h('div', { class: 'row' }, h('h2', { class: 'grow', style: 'margin:0' }, `${release.version} 的變更清單`),
        isDraft && h('button', { class: 'primary', onclick: publish }, `發布 ${release.version}`)),
      changes.length === 0 ? h('div', { class: 'empty' }, '沒有變更') : h('table', {},
        h('tr', {}, h('th', {}, '變更'), h('th', {}, '詞'), h('th', {}, '讀音'), h('th', { class: 'num' }, '詞頻'), h('th', {}, '經手'), isDraft && h('th', {})),
        changes.map((c) => h('tr', {},
          h('td', {}, h('span', { class: `chip ${c.action === 'add' ? 'ok' : 'warn'}` }, ACTION[c.action])),
          h('td', {}, c.text), h('td', { class: 'bopomofo muted' }, c.bopomofo),
          h('td', { class: 'num' }, c.action === 'add' ? fmt(c.new_frequency) : c.action === 'remove' ? fmt(c.old_frequency) : `${fmt(c.old_frequency)} → ${fmt(c.new_frequency)}`),
          h('td', { class: 'muted' }, c.editor ?? ''),
          isDraft && h('td', {}, c.action === 'add' && c.review_status === 'approved' &&
            h('button', { class: 'small', onclick: () => withdraw(c) }, '撤回')))))));
  }
  async function withdraw(c) {
    if (await attempt(() => api(`/review/${c.word_id}/withdraw`, { method: 'POST', body: { row_version: c.review_row_version } }),
      `已撤回「${c.text}」，回到待審`) !== undefined) show(draft.version);
  }
  async function publish() {
    if (!confirm(`確定發布 ${draft.version}？發布後就不能再修改。`)) return;
    const res = await attempt(() => api('/releases/publish', { method: 'POST' }));
    if (res) { toast(`已發布 ${res.version}：新增 ${res.added}、停用 ${res.removed}、調詞頻 ${res.reweighted}`); route(); }
  }
  async function create() {
    const version = prompt('新版本號', nextVersion);
    if (version && await attempt(() => api('/releases', { method: 'POST', body: { version } }), `已建立 ${version}`)) route();
  }

  root.append(h('h1', {}, '版本'), h('p', { class: 'sub' }, '每個版本最多 200 個新詞。草稿版本發布前可以撤回；發布後就不能再改。'),
    h('div', { class: 'split' }, detail, h('div', { class: 'side panel' },
      h('div', { class: 'row' }, h('h2', { class: 'grow', style: 'margin:0' }, '所有版本'),
        !draft && h('button', { class: 'small primary', onclick: create }, '建立下一版')),
      h('table', {}, releases.map((r) => h('tr', { class: 'click', onclick: () => show(r.version) },
        h('td', {}, h('strong', {}, r.version)),
        h('td', {}, r.status === 'draft' ? h('span', { class: 'chip warn' }, '草稿') : h('span', { class: 'muted' }, date(r.published_at))),
        h('td', { class: 'num muted' }, `+${r.added} −${r.removed}`)))))));
  show((draft ?? latest).version);
}

// ==================== ③ ⑥ ⑦（下一步） ====================

function meView(root) { root.append(h('h1', {}, '我的'), h('div', { class: 'panel empty' }, '下一步實作：裝置、回報、個人詞、訂閱')); }
function reportsView(root) { root.append(h('h1', {}, '回報處理'), h('div', { class: 'panel empty' }, '下一步實作')); }
function analyticsView(root) { root.append(h('h1', {}, '分析'), h('div', { class: 'panel empty' }, '下一步實作')); }

// ==================== 啟動 ====================

window.addEventListener('hashchange', route);
({ user } = await api('/me'));
route();
