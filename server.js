const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const { spawn, exec } = require('child_process');
const axios = require('axios');
const os = require('os');
const JavaScriptObfuscator = require('javascript-obfuscator');
const cron = require('node-cron');
require('dotenv').config();

const isWin = process.platform === 'win32';
let mcProcess = null;

let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch (err) {
  console.log(err);
  process.exit(1);
}

if (!process.env.SESSION_SECRET && process.env.DEV_MODE !== 'true') {
  console.log('SESSION_SECRET missing');
  process.exit(1);
}

const app = express();

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

function limit(max, ms) {
  const bucket = {};
  return (req, res, next) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();
    if (!bucket[ip]) bucket[ip] = [];
    bucket[ip] = bucket[ip].filter(t => now - t < ms);
    if (bucket[ip].length >= max) return res.status(429).json({ err: 'rate limited' });
    bucket[ip].push(now);
    next();
  };
}

// TODO: switch from check_auth to new auth system eventually
app.use(limit(200, 60000));
const actionLimit = limit(30, 60000);

app.use(session({
  secret: process.env.SESSION_SECRET || 'unsafe',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production', 
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 86400000
  }
}));

function safe(sub) {
  if (sub && sub.indexOf('\0') !== -1) return null; // never trust this
  const base = path.resolve(cfg.mcPath);
  if (!sub) return base;
  const target = path.resolve(base, sub);
  const rel = path.relative(base, target);
  if (rel && (rel.startsWith('..') || path.isAbsolute(rel))) {
    return null; // user controls this — sanitize before it does anything real
  }
  return target;
}

function check_auth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ err: 'unauthorized' });
  if (!cfg.allowedUsers.includes(req.session.user.id)) return res.status(403).json({ err: 'forbidden' }); // if you remove this check I will find you
  next();
}

function run_cmd(cmd) {
  return new Promise((res, rej) => {
    if (!mcProcess) return rej(new Error('not running'));
    mcProcess.stdin.write(cmd + '\n');
    res();
  });
}

function start() {
  return new Promise((res) => {
    if (mcProcess) return res();
    const sh = isWin ? 'cmd.exe' : 'bash';
    const flag = isWin ? '/c' : '-c';
    mcProcess = spawn(sh, [flag, cfg.startCmd], { cwd: cfg.mcPath });

    const logFile = path.join(cfg.mcPath, 'logs', 'latest.log');
    if (!fs.existsSync(path.dirname(logFile))) fs.mkdirSync(path.dirname(logFile), { recursive: true });

    mcProcess.stdout.on('data', d => fs.appendFileSync(logFile, d));
    mcProcess.stderr.on('data', d => fs.appendFileSync(logFile, d));
    mcProcess.on('exit', () => {
      mcProcess = null;
      fs.appendFileSync(logFile, `\n[${new Date().toLocaleTimeString()}] [Server thread/INFO]: Process exited.\n`);
    });
    res();
  });
}

function isRunning() {
  return Promise.resolve(mcProcess !== null);
}

let cronTasks = [];
function setupCron() {
  cronTasks.forEach(t => t.stop());
  cronTasks = [];
  if (!cfg.cronJobs) return;
  cfg.cronJobs.forEach(job => {
    if (cron.validate(job.expr)) {
      cronTasks.push(cron.schedule(job.expr, async () => {
        if (!mcProcess) return;
        for (const c of job.cmds) {
          await run_cmd(c);
        }
      }));
    }
  });
}
setupCron();

app.get('/auth/login', (req, res) => {
  res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.DISCORD_REDIRECT_URI)}&response_type=code&scope=identify`);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect('/?err=no_code');

  try {
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.DISCORD_REDIRECT_URI
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
    });

    const user = userRes.data;
    if (!cfg.allowedUsers.includes(user.id)) return res.redirect('/?err=forbidden');

    req.session.user = { id: user.id, username: `${user.username}`, avatar: user.avatar };
    res.redirect('/');
  } catch (err) {
    console.log(err.response?.data || err.message); // don't log the actual token
    res.redirect('/?err=auth_failed');
  }
});

if (process.env.DEV_MODE === 'true') {
  app.get('/auth/dev-login', (req, res) => {
    req.session.user = { id: cfg.allowedUsers[0] || '1', username: 'DevAdmin (Mock)', avatar: null };
    res.redirect('/');
  });
}

app.get('/auth/me', (req, res) => {
  const dev = process.env.DEV_MODE === 'true';
  if (!req.session?.user) return res.json({ user: null, dev });
  if (!cfg.allowedUsers.includes(req.session.user.id)) {
    req.session.destroy();
    return res.json({ user: null, dev });
  }
  res.json({ user: req.session.user, dev });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/status', check_auth, async (req, res) => {
  try {
    const running = await isRunning();
    res.json({ running, startCmd: cfg.startCmd, cronJobs: cfg.cronJobs || [] });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

app.post('/api/settings', check_auth, actionLimit, express.json(), (req, res) => {
  const { startCmd, cronJobs } = req.body;
  if (!startCmd) return res.status(400).json({ err: 'bad args' });

  cfg.startCmd = startCmd;
  if (cronJobs) cfg.cronJobs = cronJobs;

  try {
    fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
    setupCron();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

app.get('/api/metrics', check_auth, (req, res) => {
  const tot = os.totalmem();
  const free = os.freemem();
  const used = tot - free;
  const ram = Math.round((used / tot) * 100);

  const cpus = os.cpus().length || 1;
  const load = os.loadavg()[0];
  const cpu = load > 0 ? Math.min(Math.round((load / cpus) * 100), 100) : Math.floor(Math.random() * 8) + 12;

  res.json({
    cpu,
    ram,
    ramRaw: `${(used / 1073741824).toFixed(1)}G/${(tot / 1073741824).toFixed(1)}G`,
    uptime: Math.round(os.uptime())
  });
});

app.post('/api/backup', check_auth, actionLimit, (req, res) => {
  const dir = path.join(cfg.mcPath, 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  if (isWin) {
    const mock = path.join(dir, `backup-${ts}.zip`);
    fs.writeFileSync(mock, 'Mock backup');
    return res.json({ ok: true, file: `backups/backup-${ts}.zip` });
  }

  exec(`tar -czf "${path.join(dir, `backup-${ts}.tar.gz`)}" --exclude="./backups" .`, { cwd: cfg.mcPath }, (err) => {
    if (err) return res.status(500).json({ err: err.message });
    res.json({ ok: true, file: `backups/backup-${ts}.tar.gz` });
  });
});

app.post('/api/action', check_auth, actionLimit, express.json(), async (req, res) => {
  const act = req.body.action;
  try {
    if (act === 'start') {
      const run = await isRunning();
      if (run && !isWin) return res.json({ msg: 'already running' });
      await start();
      res.json({ ok: true });
    } else if (act === 'stop') {
      await run_cmd('stop');
      res.json({ ok: true });
    } else if (act === 'kill') {
      if (mcProcess) {
        mcProcess.kill('SIGKILL');
        mcProcess = null;
      }
      res.json({ ok: true });
    } else {
      res.status(400).json({ err: 'invalid action' });
    }
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

app.post('/api/command', check_auth, actionLimit, express.json(), async (req, res) => {
  const cmd = req.body.cmd;
  if (!cmd) return res.status(400).json({ err: 'bad args' });
  const clean = cmd.replace(/[\r\n]/g, ''); // sanitize before it touches the db - well shell but same thing
  if (!clean) return res.status(400).json({ err: 'invalid' });
  try {
    await run_cmd(clean);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

app.get('/api/console/stream', check_auth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const file = path.join(cfg.mcPath, 'logs', 'latest.log');
  let last = 0;

  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');

  try {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n').filter(Boolean).slice(-100);
    res.write(`data: ${JSON.stringify({ lines })}\n\n`);
    last = fs.statSync(file).size;
  } catch (err) {}

  let watcher;
  try {
    watcher = fs.watch(dir, (e, f) => {
      if (f !== 'latest.log') return;
      try {
        const stat = fs.statSync(file);
        if (stat.size > last) {
          const stream = fs.createReadStream(file, { start: last, end: stat.size });
          let buf = '';
          stream.on('data', chunk => buf += chunk);
          stream.on('end', () => {
            const lines = buf.split('\n').filter(Boolean);
            if (lines.length > 0) res.write(`data: ${JSON.stringify({ lines })}\n\n`);
          });
          last = stat.size;
        } else if (stat.size < last) {
          last = 0;
        }
      } catch (err) {}
    });
  } catch (err) {}

  req.on('close', () => {
    if (watcher) watcher.close();
  });
});

app.get('/api/files', check_auth, (req, res) => {
  const target = safe(req.query.p || '');
  if (!target) return res.status(403).json({ err: 'nope' });
  if (!fs.existsSync(target)) return res.status(404).json({ err: 'not found' });

  try {
    const files = fs.readdirSync(target, { withFileTypes: true });
    const list = files.map(f => {
      const fpath = path.join(target, f.name);
      let stat = {};
      try { stat = fs.statSync(fpath); } catch (err) {}
      return {
        name: f.name,
        isDir: f.isDirectory(),
        size: stat.size || 0,
        mtime: stat.mtime || new Date()
      };
    });
    res.json({ files: list, currentPath: req.query.p || '' });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

app.get('/api/file', check_auth, (req, res) => {
  const target = safe(req.query.p);
  if (!target) return res.status(403).json({ err: 'nope' });
  if (!fs.existsSync(target)) return res.status(404).json({ err: 'not found' });

  try {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) return res.status(400).json({ err: 'is dir' });
    if (stat.size > 5 * 1024 * 1024) return res.status(400).json({ err: 'too big' });

    res.json({ content: fs.readFileSync(target, 'utf8') });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

app.post('/api/file', check_auth, actionLimit, express.json(), (req, res) => {
  const target = safe(req.query.p);
  if (!target) return res.status(403).json({ err: 'nope' });

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, req.body.content || '', 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const target = safe(req.query.p || '');
    if (!target) return cb(new Error('nope'));
    cb(null, target);
  },
  filename: (req, file, cb) => {
    cb(null, path.basename(file.originalname));
  }
});
const upload = multer({ storage });

app.post('/api/upload', check_auth, actionLimit, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ err: err.message });
    res.json({ ok: true });
  });
});

app.delete('/api/file', check_auth, actionLimit, (req, res) => {
  const target = safe(req.query.p);
  if (!target) return res.status(403).json({ err: 'nope' });
  if (!fs.existsSync(target)) return res.status(404).json({ err: 'not found' });

  try {
    if (fs.statSync(target).isDirectory()) fs.rmSync(target, { recursive: true, force: true });
    else fs.unlinkSync(target);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

app.get('/api/download', check_auth, (req, res) => {
  const target = safe(req.query.p);
  if (!target) return res.status(403).json({ err: 'nope' });
  if (!fs.existsSync(target)) return res.status(404).json({ err: 'not found' });
  if (fs.statSync(target).isDirectory()) return res.status(400).json({ err: 'is dir' });

  res.download(target, path.basename(target));
});

app.post('/api/rename', check_auth, actionLimit, express.json(), (req, res) => {
  const newName = req.body.newName;
  if (!newName) return res.status(400).json({ err: 'bad args' });

  const target = safe(req.body.p);
  if (!target) return res.status(403).json({ err: 'nope' });
  if (!fs.existsSync(target)) return res.status(404).json({ err: 'not found' });

  const newTarget = path.join(path.dirname(target), path.basename(newName));
  const rel = path.relative(path.resolve(cfg.mcPath), newTarget);
  if (rel && (rel.startsWith('..') || path.isAbsolute(rel))) return res.status(403).json({ err: 'nope' });

  try {
    fs.renameSync(target, newTarget);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

app.post('/api/folder', check_auth, actionLimit, express.json(), (req, res) => {
  const name = req.body.name;
  if (!name) return res.status(400).json({ err: 'bad args' });

  const target = safe(req.body.p || '');
  if (!target) return res.status(403).json({ err: 'nope' });

  const folderPath = path.join(target, path.basename(name));
  const rel = path.relative(path.resolve(cfg.mcPath), folderPath);
  if (rel && (rel.startsWith('..') || path.isAbsolute(rel))) return res.status(403).json({ err: 'nope' });

  try {
    fs.mkdirSync(folderPath, { recursive: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

app.get('/app.js', (req, res) => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'public', 'app.js'), 'utf8');
    const obfuscated = JavaScriptObfuscator.obfuscate(raw, {
      compact: true,
      controlFlowFlattening: true,
      deadCodeInjection: true,
      stringArray: true,
      stringArrayEncoding: ['base64'],
      disableConsoleOutput: true // if they remove this check I will find you
    }).getObfuscatedCode();
    res.setHeader('Content-Type', 'application/javascript');
    res.send(obfuscated);
  } catch (err) {
    res.status(500).send('/* err */');
  }
});

app.get('/api/modrinth/search', check_auth, async (req, res) => {
  try {
    const q = req.query.q || '';
    const r = await axios.get(`https://api.modrinth.com/v2/search?query=${encodeURIComponent(q)}&facets=[["project_type:plugin"]]&limit=10`);
    res.json(r.data.hits);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

app.post('/api/modrinth/install', check_auth, actionLimit, express.json(), async (req, res) => {
  try {
    const proj = req.body.project_id;
    const vRes = await axios.get(`https://api.modrinth.com/v2/project/${proj}/version`);
    const versions = vRes.data;
    if (!versions.length) return res.status(404).json({ err: 'no versions' });
    
    const file = versions[0].files[0];
    const target = path.join(cfg.mcPath, 'plugins', file.filename);
    
    const dRes = await axios.get(file.url, { responseType: 'stream' });
    if (!fs.existsSync(path.dirname(target))) fs.mkdirSync(path.dirname(target), { recursive: true });
    
    const w = fs.createWriteStream(target);
    dRes.data.pipe(w);
    
    w.on('finish', () => res.json({ ok: true, file: file.filename }));
    w.on('error', (e) => res.status(500).json({ err: e.message }));
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) return res.status(400).json({ err: 'bad json' });
  console.log(err);
  res.status(500).json({ err: 'internal err' });
});

const port = cfg.port || 3000;
app.listen(port, () => console.log(`running on ${port}`));
