let user = null;
let curPath = '';
let sse = null;
let logs = [];
let currentCronJobs = [];

// DOM refs
const els = {
  login: document.getElementById('login-screen'),
  dash: document.getElementById('dashboard-screen'),
  devBtn: document.getElementById('dev-login-btn'),
  errBanner: document.getElementById('error-banner'),
  userInfo: document.getElementById('user-info'),
  statusDot: document.getElementById('status-dot'),
  statusTxt: document.getElementById('status-text'),
  termOut: document.getElementById('terminal-output'),
  termForm: document.getElementById('terminal-form'),
  termIn: document.getElementById('terminal-input'),
  pathEl: document.getElementById('current-path'),
  filesList: document.getElementById('files-list'),
  modal: document.getElementById('editor-modal'),
  editorTitle: document.getElementById('editor-title'),
  editorText: document.getElementById('editor-textarea'),
};

let editPath = '';

const params = new URLSearchParams(window.location.search);
if (params.get('err') === 'forbidden') els.errBanner.classList.remove('hidden');

async function init() {
  try {
    const res = await fetch('/auth/me');
    const data = await res.json();
    
    if (data.devMode) els.devBtn.classList.remove('hidden');
    
    if (data.user) {
      user = data.user;
      showDash();
    } else {
      showLogin();
    }
  } catch (err) {
    showLogin();
  }
}

function showLogin() {
  els.login.classList.remove('hidden');
  els.dash.classList.add('hidden');
}

function showDash() {
  els.login.classList.add('hidden');
  els.dash.classList.remove('hidden');
  
  els.userInfo.innerHTML = `
    <span class="username">${esc(user.username)}</span>
    <button id="btn-logout" class="mc-btn sm-btn">LOG OUT</button>
  `;
  document.getElementById('btn-logout').addEventListener('click', () => {
    fetch('/auth/logout', { method: 'POST' }).then(() => window.location.reload());
  });
  
  updateStatus();
  setInterval(updateStatus, 5000);

  updateMetrics();
  setInterval(updateMetrics, 5000);

  document.getElementById('btn-start').addEventListener('click', () => action('start'));
  document.getElementById('btn-stop').addEventListener('click', () => action('stop'));
  document.getElementById('btn-kill').addEventListener('click', () => {
    if (confirm('kill screen session?')) action('kill');
  });

  document.getElementById('btn-backup').addEventListener('click', backup);
  document.getElementById('btn-new-folder').addEventListener('click', mkdir);
  document.getElementById('btn-save-settings').addEventListener('click', saveCfg);
  document.getElementById('terminal-filter').addEventListener('input', renderLogs);
  document.getElementById('btn-up-dir').addEventListener('click', () => {
    if (!curPath) return;
    ls(curPath.split('/').slice(0, -1).join('/'));
  });
  document.getElementById('btn-new-file').addEventListener('click', () => {
    const name = prompt('file name:');
    if (!name) return;
    openEditor(curPath ? `${curPath}/${name}` : name, '');
  });
  
  document.getElementById('file-uploader').addEventListener('change', uploadFile);

  document.querySelectorAll('.quick-cmd-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cmd = btn.getAttribute('data-cmd');
      addLogs([`> ${cmd}`]);
      try {
        const res = await fetch('/api/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cmd })
        });
        const data = await res.json();
        if (data.err) addLogs([`err: ${data.err}`]);
      } catch (err) {
        addLogs([`err: ${err.message}`]);
      }
    });
  });

  document.getElementById('btn-save-file').addEventListener('click', saveFile);
  document.getElementById('btn-cancel-file').addEventListener('click', closeEditor);
  document.getElementById('btn-close-editor').addEventListener('click', closeEditor);

  startSse();
  ls('');
}

async function searchPlugins() {
  const q = document.getElementById('plugin-search-input').value;
  if (!q) return;
  const res = document.getElementById('plugin-results');
  res.innerHTML = '<span style="color:#aaa">Searching Modrinth...</span>';
  try {
    const r = await fetch(`/api/modrinth/search?q=${encodeURIComponent(q)}`);
    const hits = await r.json();
    if (!hits || !hits.length) {
      res.innerHTML = '<span style="color:#e74c3c">No plugins found.</span>';
      return;
    }
    res.innerHTML = hits.map(h => `
      <div style="border:1px solid #444; padding:10px; background:#1e1e1e; display:flex; justify-content:space-between; align-items:center">
        <div>
          <div style="font-weight:bold; color:#f39c12">${h.title}</div>
          <div style="font-size:0.8em; color:#aaa">${h.description}</div>
        </div>
        <button onclick="installPlugin('${h.project_id}')" style="margin:0; width:auto; border-color:#2ecc71; color:#2ecc71">Install</button>
      </div>
    `).join('');
  } catch (e) {
    res.innerHTML = '<span style="color:#e74c3c">Error: ' + e.message + '</span>';
  }
}

async function installPlugin(id) {
  if (!confirm('Install this plugin directly to the server?')) return;
  try {
    const r = await fetch('/api/modrinth/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: id })
    });
    const d = await r.json();
    if (d.ok) alert('Installed ' + d.file + ' to plugins directory! Restart server to apply.');
    else alert('Failed: ' + d.err);
  } catch (e) { alert(e.message); }
}

function renderCronList() {
  const c = document.getElementById('cron-list');
  if (!c) return;
  if (!currentCronJobs.length) {
    c.innerHTML = '<span style="color:#aaa; font-style:italic">No scheduled tasks yet.</span>';
    return;
  }
  c.innerHTML = currentCronJobs.map((j, i) => `
    <div style="border:1px solid #444; background:#1e1e1e; padding:10px; display:flex; justify-content:space-between; align-items:center">
      <div>
        <div style="color:#9b59b6; font-family:monospace; font-weight:bold">${j.expr}</div>
        <div style="font-size:0.9em; color:#aaa">> ${j.cmds.join(' && ')}</div>
      </div>
      <button onclick="deleteCron(${i})" style="margin:0; width:auto; border-color:#e74c3c; color:#e74c3c">Delete</button>
    </div>
  `).join('');
}

async function addCron() {
  const expr = document.getElementById('new-cron-expr').value;
  const cmd = document.getElementById('new-cron-cmd').value;
  if (!expr || !cmd) return alert('Fill out both fields');
  currentCronJobs.push({ expr, cmds: [cmd] });
  await saveCron();
}

async function deleteCron(i) {
  if (!confirm('Remove this task?')) return;
  currentCronJobs.splice(i, 1);
  await saveCron();
}

async function saveCron() {
  try {
    const s = document.getElementById('setting-start-cmd').value;
    const r = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startCmd: s, cronJobs: currentCronJobs })
    });
    const d = await r.json();
    if (d.ok) {
      renderCronList();
      document.getElementById('new-cron-expr').value = '';
      document.getElementById('new-cron-cmd').value = '';
    } else {
      alert(d.err);
    }
  } catch(e) { alert(e.message); }
}

async function updateStatus() {
  try {
    const res = await fetch('/api/status');
    const d = await res.json();
    
    if (d.running) {
      els.statusDot.className = 'pulse-indicator status-online';
      els.statusTxt.innerText = 'Online';
      els.statusTxt.className = 'status-online';
    } else {
      els.statusDot.className = 'pulse-indicator status-offline';
      els.statusTxt.innerText = 'Offline';
      els.statusTxt.className = 'status-offline';
    }
    
    document.getElementById('session-name').innerText = 'local-daemon';
    const sIn = document.getElementById('setting-screen-name');
    const cIn = document.getElementById('setting-start-cmd');
    if (sIn && document.activeElement !== sIn) sIn.value = 'mc-process';
    if (cIn && document.activeElement !== cIn && d.startCmd) cIn.value = d.startCmd;
    
    if (d.cronJobs) {
      currentCronJobs = d.cronJobs;
      renderCronList();
    }
  } catch (err) {
    // whatever
  }
}

async function action(act) {
  try {
    const res = await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: act })
    });
    const data = await res.json();
    if (data.err) alert(data.err);
    updateStatus();
  } catch (err) {
    alert(err.message);
  }
}

function startSse() {
  if (sse) sse.close();
  sse = new EventSource('/api/console/stream');
  sse.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.lines?.length) addLogs(data.lines);
  };
}

function addLogs(lines) {
  logs.push(...lines);
  if (logs.length > 1000) logs = logs.slice(-1000); // close enough
  renderLogs();
}

function renderLogs() {
  const filter = document.getElementById('terminal-filter').value.toLowerCase().trim();
  const bottom = els.termOut.scrollHeight - els.termOut.clientHeight <= els.termOut.scrollTop + 50;
  
  els.termOut.innerHTML = '';
  const filtered = filter ? logs.filter(l => l.toLowerCase().includes(filter)) : logs;
    
  filtered.forEach(l => {
    const div = document.createElement('div');
    div.innerText = l;
    if (l.includes('WARN')) div.className = 'log-warn';
    else if (l.includes('ERROR')) div.className = 'log-err';
    else if (l.includes('INFO')) div.className = 'log-info';
    else if (l.startsWith('> ')) div.className = 'log-cmd';
    els.termOut.appendChild(div);
  });
  
  if (bottom) els.termOut.scrollTop = els.termOut.scrollHeight;
}

els.termForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const cmd = els.termIn.value.trim();
  if (!cmd) return;
  
  els.termIn.value = '';
  addLogs([`> ${cmd}`]);
  
  try {
    const res = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd })
    });
    const data = await res.json();
    if (data.err) addLogs([`err: ${data.err}`]);
  } catch (err) {
    addLogs([`err: ${err.message}`]);
  }
});

async function ls(path) {
  curPath = path;
  els.pathEl.innerText = '/' + path;
  
  try {
    const res = await fetch(`/api/files?p=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (data.err) return alert(data.err);
    
    els.filesList.innerHTML = '';
    
    data.files.sort((a, b) => {
      if (a.isDir && !b.isDir) return -1;
      if (!a.isDir && b.isDir) return 1;
      return a.name.localeCompare(b.name);
    });
    
    if (!data.files.length) {
      els.filesList.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #888;">Empty</td></tr>`;
      return;
    }
    
    data.files.forEach(f => {
      const tr = document.createElement('tr');
      const isEd = !f.isDir && isTxt(f.name);
      
      tr.innerHTML = `
        <td>
          <span class="file-link ${f.isDir ? 'dir-link' : ''}" data-name="${esc(f.name)}" data-isdir="${f.isDir}">
            ${f.isDir ? '📁' : '📄'} ${esc(f.name)}
          </span>
        </td>
        <td>${f.isDir ? 'Folder' : 'File'}</td>
        <td>${f.isDir ? '-' : formatBytes(f.size)}</td>
        <td>${esc(new Date(f.mtime).toLocaleString())}</td>
        <td>
          <div class="action-row">
            ${isEd ? `<button class="mc-btn sm-btn green-btn btn-edit">EDIT</button>` : ''}
            ${!f.isDir ? `<a class="mc-btn sm-btn green-btn" href="/api/download?p=${encodeURIComponent(curPath ? `${curPath}/${f.name}` : f.name)}" download>GET</a>` : ''}
            <button class="mc-btn sm-btn green-btn btn-rename">RENAME</button>
            <button class="mc-btn sm-btn red-btn btn-delete">DELETE</button>
          </div>
        </td>
      `;
      
      tr.querySelector('.file-link').addEventListener('click', () => {
        const p = curPath ? `${curPath}/${f.name}` : f.name;
        if (f.isDir) ls(p);
        else if (isEd) openEditor(p);
      });
      
      if (isEd) {
        tr.querySelector('.btn-edit').addEventListener('click', () => {
          openEditor(curPath ? `${curPath}/${f.name}` : f.name);
        });
      }
      
      tr.querySelector('.btn-rename').addEventListener('click', () => {
        mv(curPath ? `${curPath}/${f.name}` : f.name, f.name);
      });
      
      tr.querySelector('.btn-delete').addEventListener('click', () => {
        rm(curPath ? `${curPath}/${f.name}` : f.name);
      });
      
      els.filesList.appendChild(tr);
    });
  } catch (err) {}
}

async function uploadFile(e) {
  const f = e.target.files[0];
  if (!f) return;
  const form = new FormData();
  form.append('file', f);
  try {
    const res = await fetch(`/api/upload?p=${encodeURIComponent(curPath)}`, { method: 'POST', body: form });
    const data = await res.json();
    if (data.ok) ls(curPath);
    else alert(data.err);
  } catch (err) {
    alert(data.message);
  }
}

async function rm(path) {
  if (!confirm(`delete ${path}?`)) return;
  try {
    const res = await fetch(`/api/file?p=${encodeURIComponent(path)}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.ok) ls(curPath);
    else alert(data.err);
  } catch (err) {
    alert(err.message);
  }
}

async function openEditor(path, content = null) {
  editPath = path;
  els.editorTitle.innerText = `Edit: ${path}`;
  els.modal.classList.remove('hidden');
  els.editorText.value = 'loading...';
  
  if (content !== null) {
    els.editorText.value = content;
    return;
  }
  
  try {
    const res = await fetch(`/api/file?p=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (data.err) {
      alert(data.err);
      closeEditor();
    } else {
      els.editorText.value = data.content;
    }
  } catch (err) {
    closeEditor();
  }
}

function closeEditor() {
  els.modal.classList.add('hidden');
  editPath = '';
}

async function saveFile() {
  try {
    const res = await fetch(`/api/file?p=${encodeURIComponent(editPath)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: els.editorText.value })
    });
    const data = await res.json();
    if (data.ok) {
      closeEditor();
      ls(curPath);
    } else {
      alert(data.err);
    }
  } catch (err) {
    alert(err.message);
  }
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function isTxt(name) {
  const exts = ['txt', 'log', 'yml', 'yaml', 'json', 'properties', 'conf', 'config', 'sh', 'bat', 'lua', 'md'];
  return exts.includes(name.split('.').pop().toLowerCase());
}

let history = [];
async function updateMetrics() {
  try {
    const res = await fetch('/api/metrics');
    const data = await res.json();
    if (data.err) return;

    document.getElementById('cpu-value').innerText = `${data.cpu}%`;
    document.getElementById('cpu-bar').style.width = `${data.cpu}%`;
    document.getElementById('ram-value').innerText = `${data.ram}%`;
    document.getElementById('ram-bar').style.width = `${data.ram}%`;
    document.getElementById('ram-raw').innerText = data.ramRaw;

    history.push({ cpu: data.cpu, ram: data.ram });
    if (history.length > 30) history.shift();
    drawChart();
  } catch (err) {}
}

function drawChart() {
  const canvas = document.getElementById('metrics-chart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  
  ctx.fillStyle = '#111';
  ctx.fillRect(0, 0, w, h);
  
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 25) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 0; y < h; y += 15) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
  
  if (history.length < 2) return;
  const step = w / 29;
  
  ctx.strokeStyle = '#fa0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  history.forEach((pt, i) => {
    const x = i * step, y = h - (pt.ram / 100) * (h - 6) - 3;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.strokeStyle = '#5f5';
  ctx.lineWidth = 2;
  ctx.beginPath();
  history.forEach((pt, i) => {
    const x = i * step, y = h - (pt.cpu / 100) * (h - 6) - 3;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

async function backup() {
  const btn = document.getElementById('btn-backup');
  const orig = btn.innerText;
  btn.innerText = 'WAIT...';
  btn.disabled = true;
  
  try {
    const res = await fetch('/api/backup', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      alert(`ok\n${data.file}`);
      ls(curPath);
    } else alert(data.err);
  } catch (err) {
    alert(err.message);
  } finally {
    btn.innerText = orig;
    btn.disabled = false;
  }
}

async function mkdir() {
  const name = prompt('folder name:');
  if (!name) return;
  
  try {
    const res = await fetch('/api/folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p: curPath, name })
    });
    const data = await res.json();
    if (data.ok) ls(curPath);
    else alert(data.err);
  } catch (err) {
    alert(err.message);
  }
}

async function mv(oldPath, oldName) {
  const newName = prompt('rename to:', oldName);
  if (!newName || newName === oldName) return;
  
  try {
    const res = await fetch('/api/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p: oldPath, newName })
    });
    const data = await res.json();
    if (data.ok) ls(curPath);
    else alert(data.err);
  } catch (err) {
    alert(err.message);
  }
}

async function saveCfg() {
  const btn = document.getElementById('btn-save-settings');
  const orig = btn.innerText;
  btn.innerText = 'SAVING...';
  btn.disabled = true;
  
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startCmd: document.getElementById('setting-start-cmd').value,
        cronJobs: currentCronJobs
      })
    });
    const data = await res.json();
    if (data.ok) {
      alert('ok');
      updateStatus();
    } else alert(data.err);
  } catch (err) {
    alert(err.message);
  } finally {
    btn.innerText = orig;
    btn.disabled = false;
  }
}

init();
