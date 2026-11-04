/**
 * Public landing page served at GET /. It explains the service and gives reviewers a small
 * in-browser console: log in as any demo user and send the API calls from the README demo.
 * Everything it does goes through the normal public API, so it bypasses nothing.
 */
export const landingPage = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gatekeeper API</title>
<style>
  :root { --bg:#f7f7f5; --card:#fff; --ink:#1d1d1b; --muted:#66655f; --line:#e2e1dc; --accent:#2f5bd3; --ok:#1f7a45; --bad:#b3261e; --code:#f0efeb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161615; --card:#1f1f1d; --ink:#ecebe6; --muted:#a3a29b; --line:#33322f; --accent:#7f9cf5; --ok:#5cc489; --bad:#f28b82; --code:#262624; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:960px; margin:0 auto; padding:32px 16px 64px; }
  h1 { font-size:28px; margin:0 0 4px; } h2 { font-size:18px; margin:32px 0 10px; }
  p { margin:6px 0; } .muted { color:var(--muted); }
  code, pre, select, input, textarea, button { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:13px; }
  code { background:var(--code); padding:1px 5px; border-radius:4px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  .scroll { overflow-x:auto; }
  .row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:8px 0; }
  select, input, textarea { background:var(--bg); color:var(--ink); border:1px solid var(--line); border-radius:6px; padding:7px 8px; }
  input[type=text] { flex:1; min-width:180px; } textarea { width:100%; min-height:60px; }
  button { background:var(--accent); color:#fff; border:0; border-radius:6px; padding:8px 12px; cursor:pointer; }
  button.ghost { background:transparent; color:var(--accent); border:1px solid var(--line); }
  .presets button { text-align:left; }
  pre#out { background:var(--code); border-radius:8px; padding:12px; overflow:auto; max-height:520px; white-space:pre-wrap; word-break:break-word; margin:8px 0 0; }
  .status { font-weight:600; } .status.ok { color:var(--ok); } .status.bad { color:var(--bad); }
</style>
</head>
<body>
<main>
  <h1>Gatekeeper</h1>
  <p class="muted">Explainable access control for NFPL customs jobs: who can do what, on which jobs, and why.</p>
  <p>This is a live API (Node, Express, Postgres). Every decision says <em>why</em>: allowed under which grant, or denied with a reason code and a step-by-step trace. Source and design notes: <a href="https://github.com/Nexuskiller369/gatekeeper">GitHub</a>.</p>
  <p class="muted">The demo data is reset whenever the server restarts. On the free hosting plan the server sleeps when idle, so the first request can take about 30 seconds.</p>

  <h2>Try it</h2>
  <div class="card">
    <div class="row">
      <label for="user">Log in as</label>
      <select id="user"></select>
      <button id="login">Log in</button>
      <span id="who" class="muted">Not logged in</span>
    </div>
    <p class="muted">All demo users have the password <code>Password123!</code>.</p>

    <p style="margin-top:14px"><strong>Demo steps</strong> <span class="muted">(each one logs in as the right person)</span></p>
    <div class="row presets" id="presets"></div>

    <p style="margin-top:14px"><strong>Custom request</strong> <span class="muted">(as the logged-in user)</span></p>
    <div class="row">
      <select id="method"><option>GET</option><option>POST</option><option>PATCH</option></select>
      <input type="text" id="path" value="/auth/me" aria-label="Path">
      <button id="send">Send</button>
    </div>
    <textarea id="body" placeholder='JSON body, e.g. {"reason":"Duplicate filing"}' aria-label="Request body"></textarea>
    <div class="row"><span id="status" class="status"></span></div>
    <pre id="out">Pick a demo step or log in and send a request.</pre>
  </div>

  <h2>Demo users</h2>
  <div class="card scroll"><table>
    <thead><tr><th>User</th><th>Access</th></tr></thead>
    <tbody id="users"></tbody>
  </table></div>

  <h2>Main endpoints</h2>
  <div class="card scroll"><table>
    <tbody>
      <tr><td><code>GET /health</code></td><td>Is it up (no login needed)</td></tr>
      <tr><td><code>POST /auth/login</code></td><td><code>{"email","password"}</code> returns a bearer token</td></tr>
      <tr><td><code>GET /auth/me</code></td><td>Who I am and my access in plain English</td></tr>
      <tr><td><code>GET /jobs</code> · <code>/jobs/waiting-for-me</code></td><td>Jobs I can see · jobs I can act on now</td></tr>
      <tr><td><code>POST /jobs/:id/{prepare|check|reject|file|cancel|reopen}</code></td><td>Workflow actions, each checked and recorded</td></tr>
      <tr><td><code>GET /jobs/:id/history</code></td><td>Who did what, under which grant</td></tr>
      <tr><td><code>GET /jobs/:id/who-could-act?action=&amp;at=</code></td><td>Who could act on a job at a point in time</td></tr>
      <tr><td><code>POST /authorization/check</code></td><td>Explain allow or deny for several users at once</td></tr>
      <tr><td><code>GET /access-grants</code> · <code>/delegations</code> · <code>/audit/access</code></td><td>Access admin and audit</td></tr>
    </tbody>
  </table></div>
</main>
<script>
const USERS = [
  ['anita','Access admin (everything)'], ['bharat','Access admin, Delhi only'], ['omar','Ops admin + filer'],
  ['olivia','Ops admin, Delhi only'], ['alice','Maker'], ['sarah','Maker; checker for ACME and BLUESKY'],
  ['raj','Checker for ACME, Mumbai imports only'], ['priya','Checker for CORAL and DELTA'], ['dev','Checker for EVEREST'],
  ['meera','Checker, Delhi'], ['karan','Checker, Mumbai/Bengaluru/Chennai'], ['fiona','Filer'], ['farhan','Filer, Mumbai'],
  ['vikram','Maker, Chennai'], ['nisha','Maker for GLOBEX/HORIZON; checker for FALCON'], ['lena','Was FALCON checker (revoked); now Kolkata maker'],
  ['eric','Inactive maker (login refused)'], ['ian','Internal viewer'], ['tom','Client: Acme Pharma'], ['clara','Client: Bluesky Electronics'],
];
const PRESETS = [
  ['1. Who am I? (sarah)', 'sarah', 'GET', '/auth/me'],
  ['2. Why can she and he can\'t? (anita)', 'anita', 'POST', '/authorization/check', {action:'job.check', jobId:'NF-DEMO-03', userIds:['sarah','raj','alice']}],
  ['3a. Sarah checks her own job: SOD', 'sarah', 'POST', '/jobs/NF-DEMO-02/check'],
  ['3b. Raj checks it instead', 'raj', 'POST', '/jobs/NF-DEMO-02/check'],
  ['3c. Fiona files it', 'fiona', 'POST', '/jobs/NF-DEMO-02/file'],
  ['4a. Edit a filed job: locked', 'sarah', 'PATCH', '/jobs/NF-DEMO-04', {notes:'x'}],
  ['4b. Ops admin cancels it with a reason', 'omar', 'POST', '/jobs/NF-DEMO-04/cancel', {reason:'Duplicate filing'}],
  ['5. Job history (anita)', 'anita', 'GET', '/jobs/NF-DEMO-04/history'],
  ['6. Client sees only their jobs (tom)', 'tom', 'GET', '/jobs'],
  ['7. Waiting for me (raj)', 'raj', 'GET', '/jobs/waiting-for-me'],
  ['8. Access audit log (anita)', 'anita', 'GET', '/audit/access'],
];
const $ = (id) => document.getElementById(id);
let token = null, current = null;

for (const [id, desc] of USERS) {
  $('user').add(new Option(id + ' (' + desc + ')', id));
  const tr = document.createElement('tr');
  tr.innerHTML = '<td><code>' + id + '@nfpl.test</code></td><td></td>';
  tr.lastChild.textContent = desc;
  $('users').appendChild(tr);
}
$('user').value = 'sarah';

function show(status, data) {
  const s = $('status');
  s.textContent = status ? 'HTTP ' + status : '';
  s.className = 'status ' + (status >= 200 && status < 300 ? 'ok' : 'bad');
  $('out').textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
}

async function login(id) {
  $('out').textContent = 'Logging in as ' + id + '... (first request may take ~30 s while the server wakes up)';
  const r = await fetch('/auth/login', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ email: id + '@nfpl.test', password: 'Password123!' }) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { token = null; current = null; $('who').textContent = 'Not logged in'; show(r.status, data); return false; }
  token = data.token; current = id; $('user').value = id;
  $('who').textContent = 'Logged in as ' + id;
  return true;
}

async function call(method, path, body) {
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  if (body !== undefined) headers['content-type'] = 'application/json';
  $('method').value = method; $('path').value = path;
  $('body').value = body === undefined ? '' : JSON.stringify(body);
  $('out').textContent = method + ' ' + path + ' ...';
  try {
    const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    show(r.status, data);
  } catch (e) { show(0, 'Request failed: ' + e.message); }
}

for (const [label, user, method, path, body] of PRESETS) {
  const b = document.createElement('button');
  b.className = 'ghost'; b.textContent = label;
  b.onclick = async () => { if (current !== user && !(await login(user))) return; call(method, path, body); };
  $('presets').appendChild(b);
}

$('login').onclick = async () => { if (await login($('user').value)) call('GET', '/auth/me'); };
$('send').onclick = () => {
  const raw = $('body').value.trim();
  let body;
  if (raw) { try { body = JSON.parse(raw); } catch { show(0, 'The body is not valid JSON.'); return; } }
  call($('method').value, $('path').value.trim() || '/', body);
};
</script>
</body>
</html>`;
