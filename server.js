const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] }, transports: ['websocket', 'polling'] });
const PORT = process.env.PORT || 3000;
const MATCH_MS = 5 * 60 * 1000;
const MAPS = ['foundry','outpost','neon','verdant','glacier','sunset','tiny'];
const WEAPONS = {
  'AR-4': { damage: 19, range: 440, spread: .09 }, 'VPR-9': { damage: 12, range: 260, spread: .16 },
  'M12 BREACH': { damage: 9, range: 190, spread: .34 }, 'DMR-7': { damage: 38, range: 440, spread: .035 },
  default: { damage: 16, range: 350, spread: .1 }
};
const players = new Map(), rooms = new Map(), rankedQueue = [], partyRooms = new Map();
const memoryBoard = new Map();
let supabaseReady = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const authReady = !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY);
const supabaseBase = () => String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
async function verifyToken(token) { if (!authReady || !token) throw new Error('Account system is not configured or session is missing.'); const r = await fetch(supabaseBase() + '/auth/v1/user', { headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } }); if (!r.ok) throw new Error('Your session is invalid or expired. Please sign in again.'); return await r.json(); }
async function requireUser(req, res, next) { try { const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''); req.authUser = await verifyToken(token); next(); } catch (e) { res.status(401).json({ error: e.message || 'Sign in required.' }); } }
async function readProfile(userId) { const url = supabaseBase() + '/rest/v1/lsa_profiles?id=eq.' + encodeURIComponent(userId) + '&select=id,username,game_state,updated_at'; const r = await fetch(url, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }); if (!r.ok) throw new Error(`Profile read failed (${r.status})`); const rows = await r.json(); return rows[0] || null; }
async function writeProfile(user, gameState) { const username = safeText(user.user_metadata?.username || user.email?.split('@')[0] || 'PLAYER'); const body = { id: user.id, username, game_state: gameState, updated_at: new Date().toISOString() }; const r = await fetch(supabaseBase() + '/rest/v1/lsa_profiles?on_conflict=id', { method: 'POST', headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(body) }); if (!r.ok) throw new Error(`Profile write failed (${r.status})`); }

app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS'); if (req.method === 'OPTIONS') return res.sendStatus(204); next(); });
app.use(express.json({ limit: '256kb' }));
app.get('/', (_req, res) => res.status(200).send('LAST STAND ARENA multiplayer server is online.'));
app.get('/health', (_req, res) => res.json({ ok: true, connected: players.size, activeMatches: [...rooms.values()].filter(r => r.status === 'playing').length, leaderboardStorage: supabaseReady ? 'supabase' : 'temporary-memory', accounts: authReady ? 'enabled' : 'not-configured' }));
app.get('/api/config', (_req, res) => res.json({ authEnabled: authReady, supabaseUrl: authReady ? process.env.SUPABASE_URL : '', supabaseAnonKey: authReady ? process.env.SUPABASE_ANON_KEY : '' }));
app.post('/api/check-username', async (req, res) => { try { if (!authReady) return res.status(503).json({ error: 'Account system is not configured.' }); const username = safeText(req.body?.username, '', 18); if (!/^[A-Za-z0-9_ -]{3,18}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–18 characters: letters, numbers, spaces, _ or -.' }); const url = supabaseBase() + '/rest/v1/lsa_profiles?select=id&username=ilike.' + encodeURIComponent(username) + '&limit=1'; const r = await fetch(url, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }); if (!r.ok) throw new Error('Could not check username.'); const rows = await r.json(); res.json({ available: rows.length === 0 }); } catch (e) { res.status(500).json({ error: 'Could not check username availability.' }); } });
app.get('/api/admin-status', requireUser, (req, res) => { const ownerId = String(process.env.OWNER_USER_ID || '').trim(); res.json({ isOwner: !!ownerId && req.authUser.id === ownerId }); });
app.get('/api/career-leaderboard', async (_req, res) => { try { if (!supabaseReady) return res.status(503).json({ error: 'Cloud leaderboard is not configured.' }); const url = supabaseBase() + '/rest/v1/lsa_profiles?select=id,username,game_state&limit=500'; const r = await fetch(url, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } }); if (!r.ok) throw new Error(`Supabase read failed (${r.status})`); const profiles = await r.json(); const rows = profiles.map(p => { const s = p.game_state || {}; const kills = Number(s.kills) || 0, deaths = Number(s.deaths) || 0; return { username: safeText(p.username || s.name || 'PLAYER'), verified: !!process.env.OWNER_USER_ID && p.id === String(process.env.OWNER_USER_ID).trim(), bot_kills: Number(s.botKills) || 0, real_kills: Number(s.realKills) || 0, level: Math.floor((Number(s.xp) || 0) / 250) + 1, coins_spent: Number(s.coinsSpent) || 0, wins: Number(s.wins) || 0, kd: kills / Math.max(1, deaths), kills, deaths }; }).sort((a,b) => b.level-a.level || b.real_kills-a.real_kills || b.bot_kills-a.bot_kills).slice(0,100); res.json({ rows }); } catch (e) { console.error('Career leaderboard failed:', e.message); res.status(500).json({ error: 'Could not load career leaderboard.' }); } });
async function addFriendPair(a,b){if(!a||!b||a===b)return;const url=supabaseBase()+'/rest/v1/lsa_friends';for(const row of [{user_id:a,friend_id:b},{user_id:b,friend_id:a}]){const r=await fetch(url+'?on_conflict=user_id,friend_id',{method:'POST',headers:{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,'Content-Type':'application/json',Prefer:'resolution=ignore-duplicates,return=minimal'},body:JSON.stringify(row)});if(!r.ok)throw new Error('Could not save friend connection.');}}
app.get('/api/profile', requireUser, async (req, res) => { try { let profile = await readProfile(req.authUser.id); if(!profile){await writeProfile(req.authUser,{});profile=await readProfile(req.authUser.id);} const ownerId=String(process.env.OWNER_USER_ID||'').trim();if(ownerId&&ownerId!==req.authUser.id)await addFriendPair(req.authUser.id,ownerId);res.json({ profile }); } catch (e) { console.error('Profile load failed:',e.message);res.status(500).json({ error: 'Could not load cloud profile.' }); } });
app.get('/api/friends', requireUser, async (req,res)=>{try{const u=supabaseBase()+'/rest/v1/lsa_friends?user_id=eq.'+encodeURIComponent(req.authUser.id)+'&select=friend_id,created_at&order=created_at.asc';const r=await fetch(u,{headers:{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`}});if(!r.ok)throw new Error('Friend list query failed');const links=await r.json();if(!links.length)return res.json({friends:[]});const ids=links.map(x=>x.friend_id).join(',');const pr=await fetch(supabaseBase()+'/rest/v1/lsa_profiles? id=in.('+ids+')&select=id,username,game_state'.replace('? id','?id'),{headers:{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`}});if(!pr.ok)throw new Error('Friend profiles query failed');res.json({friends:await pr.json()});}catch(e){console.error('Friends load failed:',e.message);res.status(500).json({error:'Could not load friends.'})}});
app.post('/api/friends', requireUser, async (req,res)=>{try{const username=safeText(req.body?.username,'',18);if(!username) return res.status(400).json({error:'Enter a username.'});const u=supabaseBase()+'/rest/v1/lsa_profiles?select=id,username&username=ilike.'+encodeURIComponent(username)+'&limit=1';const r=await fetch(u,{headers:{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`}});if(!r.ok)throw new Error('Could not search players');const rows=await r.json();if(!rows.length)return res.status(404).json({error:'No account found with that username. They need to sign in at least once.'});if(rows[0].id===req.authUser.id)return res.status(400).json({error:'You cannot add yourself.'});await addFriendPair(req.authUser.id,rows[0].id);res.json({ok:true,username:rows[0].username});}catch(e){console.error('Add friend failed:',e.message);res.status(500).json({error:e.message||'Could not add friend.'})}});

app.delete('/api/friends/:username', requireUser, async (req,res)=>{try{
 const username=safeText(decodeURIComponent(req.params.username||''),'',18);
 const q=supabaseBase()+'/rest/v1/lsa_profiles?select=id&username=ilike.'+encodeURIComponent(username)+'&limit=1';
 const r=await fetch(q,{headers:{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`}});
 if(!r.ok)throw new Error('Could not find friend profile');const rows=await r.json();if(!rows.length)return res.status(404).json({error:'Friend not found.'});
 const friendId=rows[0].id;const base=supabaseBase()+'/rest/v1/lsa_friends';
 for(const url of [base+'?user_id=eq.'+encodeURIComponent(req.authUser.id)+'&friend_id=eq.'+encodeURIComponent(friendId),base+'?user_id=eq.'+encodeURIComponent(friendId)+'&friend_id=eq.'+encodeURIComponent(req.authUser.id)]){
 const del=await fetch(url,{method:'DELETE',headers:{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`}});
 if(!del.ok)throw new Error('Could not remove friend connection.');
 }res.json({ok:true});
 }catch(e){console.error('Remove friend failed:',e.message);res.status(500).json({error:e.message||'Could not remove friend.'})}});

app.put('/api/profile', requireUser, async (req, res) => { try { const state = req.body?.game_state; if (!state || typeof state !== 'object' || JSON.stringify(state).length > 200000) return res.status(400).json({ error: 'Invalid or too large profile.' }); const safeState = { ...state, name: safeText(req.authUser.user_metadata?.username || req.authUser.email?.split('@')[0] || 'PLAYER') }; await writeProfile(req.authUser, safeState); res.json({ ok: true }); } catch (e) { console.error('Cloud profile save failed:', e.message); res.status(500).json({ error: 'Could not save cloud profile.' }); } });
function safeText(value, fallback = 'ROOKIE', max = 18) { return String(value || fallback).replace(/[^\w -]/g, '').trim().slice(0, max) || fallback; }
function safeMap(value) { return MAPS.includes(value) ? value : 'foundry'; }
function safeColor(value) { return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : '#48d9d2'; }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo)); }
function code() { return crypto.randomBytes(3).toString('hex').toUpperCase(); }
function boardKey(name, map) { return `${name.toLowerCase()}|${map}`; }
async function saveBoard(name, map, result) {
  for (const mapKey of ['all', map]) {
    const key = boardKey(name, mapKey); const old = memoryBoard.get(key) || { username: name, map_key: mapKey, wins: 0, losses: 0, kills: 0, deaths: 0 };
    old.wins += result.win ? 1 : 0; old.losses += result.draw ? 0 : (result.win ? 0 : 1); old.kills += result.kills || 0; old.deaths += result.deaths || 0; old.updated_at = new Date().toISOString(); memoryBoard.set(key, old);
    if (supabaseReady) {
      try {
        const base = process.env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/lsa_leaderboard';
        const headers = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' };
        const query = `?on_conflict=username,map_key`;
        const get = await fetch(`${base}?select=username,map_key,wins,losses,kills,deaths&username=eq.${encodeURIComponent(name)}&map_key=eq.${mapKey}`, { headers });
        if (!get.ok) throw new Error(`Supabase read ${get.status}`);
        const rows = await get.json(), previous = rows[0] || { wins: 0, losses: 0, kills: 0, deaths: 0 };
        const body = { username: name, map_key: mapKey, wins: previous.wins + (result.win ? 1 : 0), losses: previous.losses + (result.win ? 0 : 1), kills: previous.kills + (result.kills || 0), deaths: previous.deaths + (result.deaths || 0), updated_at: new Date().toISOString() };
        const put = await fetch(base + query, { method: 'POST', headers, body: JSON.stringify(body) }); if (!put.ok) throw new Error(`Supabase write ${put.status}`);
      } catch (e) { console.error('Leaderboard persistence failed:', e.message); }
    }
  }
}
async function getBoard(map) {
  map = map === 'all' ? 'all' : safeMap(map);
  if (supabaseReady) {
    try {
      const base = process.env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/lsa_leaderboard';
      const q = `?select=username,map_key,wins,losses,kills,deaths&map_key=eq.${encodeURIComponent(map)}&order=wins.desc,kills.desc&limit=50`;
      const r = await fetch(base + q, { headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` } });
      if (r.ok) return await r.json();
    } catch (e) { console.error('Leaderboard read failed:', e.message); }
  }
  return [...memoryBoard.values()].filter(x => x.map_key === map).sort((a,b) => b.wins-a.wins || b.kills-a.kills).slice(0,50);
}
app.get('/api/leaderboard', async (req, res) => res.json({ map: req.query.map === 'all' ? 'all' : safeMap(req.query.map), persistent: supabaseReady, rows: await getBoard(req.query.map || 'all') }));
function publicPlayer(p) { return { id: p.id, name: p.name, color: p.color, x: p.x, y: p.y, angle: p.angle, hp: p.hp, kills: p.kills || 0, deaths: p.deaths || 0 }; }
function removeFromQueue(id) { for (let i = rankedQueue.length - 1; i >= 0; i--) if (rankedQueue[i].id === id) rankedQueue.splice(i, 1); }
function createRoom(host, map, isRanked = false) {
  let roomCode = code(); while (rooms.has(roomCode)) roomCode = code();
  const room = { code: roomCode, map: safeMap(map), ranked: isRanked, status: 'waiting', players: [], createdAt: Date.now(), timer: null, endsAt: null };
  rooms.set(roomCode, room); room.players.push(host); host.roomCode = roomCode; host.socket.join(roomCode); return room;
}
function startMatch(room) {
  if (!room || room.status === 'playing' || room.players.length !== 2) return;
  room.status = 'playing'; room.endsAt = Date.now() + MATCH_MS;
  const spawns = room.map === 'tiny' ? [{ x: 130, y: 350, angle: 0 }, { x: 770, y: 350, angle: Math.PI }] : [{ x: 500, y: 1300, angle: 0 }, { x: 3100, y: 1300, angle: Math.PI }];
  room.players.forEach((p, i) => { p.hp = 100; p.kills = 0; p.deaths = 0; p.x = spawns[i].x; p.y = spawns[i].y; p.angle = spawns[i].angle; p.ammo = 30; p.socket.emit('matchStart', { roomCode: room.code, ranked: room.ranked, map: room.map, duration: 300, endsAt: room.endsAt, you: p.id, spawn: spawns[i], players: room.players.map(publicPlayer) }); });
  io.to(room.code).emit('matchState', room.players.map(publicPlayer));
  room.timer = setTimeout(() => finishMatch(room, 'time'), MATCH_MS);
  room.syncTimer = setInterval(() => { if (room.status !== 'playing') { clearInterval(room.syncTimer); return; } const remaining = Math.max(0, Math.ceil((room.endsAt - Date.now()) / 1000)); io.to(room.code).emit('timerSync', { remaining, endsAt: room.endsAt }); if (remaining <= 0) clearInterval(room.syncTimer); }, 1000);
}
async function finishMatch(room, reason = 'time', disconnectedId = null) {
  if (!room || room.status !== 'playing') return;
  room.status = 'finished'; if (room.timer) clearTimeout(room.timer); if (room.syncTimer) clearInterval(room.syncTimer);
  const [a,b] = room.players; if (!a || !b) { rooms.delete(room.code); return; }
  let winner = null;
  if (disconnectedId) winner = room.players.find(p => p.id !== disconnectedId) || null;
  else if (a.kills !== b.kills) winner = a.kills > b.kills ? a : b;
  const results = room.players.map(p => ({ id: p.id, name: p.name, kills: p.kills || 0, deaths: p.deaths || 0, win: !!winner && p.id === winner.id, result: !winner ? 'draw' : p.id === winner.id ? 'win' : 'loss' }));
  for (const p of room.players) {
    await saveBoard(p.name, room.map, { win: !!winner && p.id === winner.id, draw: !winner, kills: p.kills || 0, deaths: p.deaths || 0 });
    p.socket.emit('matchEnd', { reason, winner: winner?.name || null, results, map: room.map, ranked: room.ranked });
    p.roomCode = null; p.socket.leave(room.code);
  }
  io.to(room.code).emit('roomClosed'); rooms.delete(room.code);
}
function playerDisconnected(p) {
  removeFromQueue(p.id);
  const party = partyRooms.get(p.partyCode); if (party) { party.members.delete(p.id); if (!party.members.size) partyRooms.delete(party.code); else { if (party.hostId === p.id) { const first = party.members.values().next().value; party.hostId = first.id; party.hostName = first.name; } io.to('party:'+party.code).emit('partyUpdate', { partyCode: party.code, host: party.hostName, members: [...party.members.values()] }); } }
  if (!p.roomCode) return;
  const room = rooms.get(p.roomCode); if (!room) return;
  if (room.status === 'playing') finishMatch(room, 'disconnect', p.id);
  else { room.players = room.players.filter(x => x.id !== p.id); io.to(room.code).emit('privateRoomUpdate', { roomCode: room.code, waiting: true, message: 'Host or guest disconnected.' }); if (!room.players.length) rooms.delete(room.code); }
}
io.use(async (socket, next) => { try { const token = socket.handshake.auth?.accessToken; socket.authUser = await verifyToken(token); next(); } catch (e) { next(new Error(e.message || 'Sign in required.')); } });
io.on('connection', socket => {
  const authName = safeText(socket.authUser.user_metadata?.username || socket.authUser.email?.split('@')[0] || 'PLAYER');
  const p = { id: socket.id, socket, userId: socket.authUser.id, name: authName, color: '#48d9d2', x: 1800, y: 1300, angle: 0, hp: 100, kills: 0, deaths: 0, roomCode: null };
  players.set(socket.id, p);
  const broadcastOnlinePlayers = () => io.emit('onlinePlayersList', [...players.values()].map(x => ({ name: x.name })));
  broadcastOnlinePlayers();
  socket.on('joinArena', data => { p.color = safeColor(data?.color); socket.emit('authenticated', { username: p.name }); broadcastOnlinePlayers(); });
  socket.on('requestOnlinePlayers', () => socket.emit('onlinePlayersList', [...players.values()].map(x => ({ name: x.name }))));
  socket.on('leaveMatch', async () => { const room = rooms.get(p.roomCode); if (room) await finishMatch(room, 'forfeit', p.id); removeFromQueue(p.id); socket.emit('leaveMatchAck', { ok: true }); });
  // Invite currently connected players by exact username. 1v1 invitations create a private room;
  // party invitations create a social lobby (party members can then coordinate before a match).
  socket.on('inviteFriend', async data => {
    const targetName = safeText(data?.username, '', 18).toLowerCase();
    const kind = data?.kind === 'party' ? 'party' : 'duel';
    if (!targetName) return socket.emit('inviteError', 'Enter your friend’s username.');
    if (targetName === p.name.toLowerCase()) return socket.emit('inviteError', 'You cannot invite yourself.');
    const target = [...players.values()].find(x => x.name.toLowerCase() === targetName);
    if (!target) return socket.emit('inviteError', 'That player is not connected to the online server right now. Ask them to connect first.');
    if (kind === 'duel') {
      // Let players arrange a new duel from inside a match; the current match is recorded as a forfeit.
      if (p.roomCode) { const currentRoom = rooms.get(p.roomCode); if (currentRoom) await finishMatch(currentRoom, 'forfeit', p.id); }
      const room = createRoom(p, data?.map, false);
      target.socket.emit('gameInvite', { kind, from: p.name, roomCode: room.code, map: room.map, inviteId: crypto.randomUUID() });
      socket.emit('inviteSent', { kind, username: target.name, roomCode: room.code, message: `1v1 invitation sent to ${target.name}. Waiting for them to accept.` });
    } else {
      let party = [...partyRooms.values()].find(x => x.hostId === p.id || x.members.has(p.id));
      if (!party) { let partyCode = code(); while (partyRooms.has(partyCode)) partyCode = code(); party = { code: partyCode, hostId: p.id, hostName: p.name, members: new Map(), createdAt: Date.now() }; party.members.set(p.id, { id:p.id, name:p.name }); partyRooms.set(partyCode, party); p.partyCode = party.code; p.socket.join('party:'+party.code); }
      if (party.members.size >= 4) return socket.emit('inviteError', 'Your party is full (maximum 4 players).');
      target.socket.emit('gameInvite', { kind, from: p.name, partyCode: party.code, inviteId: crypto.randomUUID() });
      socket.emit('inviteSent', { kind, username: target.name, partyCode: party.code, message: `Party invitation sent to ${target.name}.` });
      socket.emit('partyUpdate', { partyCode: party.code, host: party.hostName, members: [...party.members.values()] });
    }
  });
  socket.on('acceptGameInvite', async data => {
    const kind = data?.kind === 'party' ? 'party' : 'duel';
    if (kind === 'duel') {
      const room = rooms.get(String(data?.roomCode || '').trim().toUpperCase());
      if (!room || room.ranked || room.status !== 'waiting') return socket.emit('inviteError', 'That 1v1 invitation has expired or the room is no longer available.');
      if (p.roomCode) { const currentRoom = rooms.get(p.roomCode); if (currentRoom) await finishMatch(currentRoom, 'forfeit', p.id); }
      if (room.players.length !== 1) return socket.emit('inviteError', 'That 1v1 room is full.');
      p.color = safeColor(data?.color); p.roomCode = room.code; p.socket.join(room.code); room.players.push(p);
      io.to(room.code).emit('privateRoomUpdate', { roomCode: room.code, waiting: false, message: 'Invitation accepted. Starting 1v1…' }); startMatch(room);
    } else {
      const party = partyRooms.get(String(data?.partyCode || '').trim().toUpperCase());
      if (!party) return socket.emit('inviteError', 'That party invitation has expired.');
      if (party.members.size >= 4 && !party.members.has(p.id)) return socket.emit('inviteError', 'That party is full (maximum 4 players).');
      party.members.set(p.id, { id:p.id, name:p.name }); p.partyCode = party.code; socket.join('party:'+party.code);
      io.to('party:'+party.code).emit('partyUpdate', { partyCode: party.code, host: party.hostName, members: [...party.members.values()] });
    }
  });
  socket.on('leaveParty', () => { const party = partyRooms.get(p.partyCode); if (party) { party.members.delete(p.id); socket.leave('party:'+party.code); if (!party.members.size) partyRooms.delete(party.code); else { if (party.hostId === p.id) { const first = party.members.values().next().value; party.hostId = first.id; party.hostName = first.name; } io.to('party:'+party.code).emit('partyUpdate', { partyCode: party.code, host: party.hostName, members: [...party.members.values()] }); } } p.partyCode = null; socket.emit('partyUpdate', { partyCode:null, host:null, members:[] }); });
  socket.on('move', data => {
    if (!data) return;
    p.color = safeColor(data.color);
    const roomForMove = rooms.get(p.roomCode); const maxX = roomForMove?.map === 'tiny' ? 887 : 3587; const maxY = roomForMove?.map === 'tiny' ? 687 : 2587; p.x = clamp(data.x, 13, maxX); p.y = clamp(data.y, 13, maxY); p.angle = clamp(data.angle, -Math.PI * 100, Math.PI * 100);
    const room = rooms.get(p.roomCode); if (room?.status === 'playing') io.to(room.code).emit('playerMoved', publicPlayer(p));
  });
  socket.on('joinRankedQueue', async data => {
    if (p.roomCode) { const currentRoom = rooms.get(p.roomCode); if (currentRoom) await finishMatch(currentRoom, 'forfeit', p.id); }
    removeFromQueue(p.id); p.color = safeColor(data?.color); p.queueMap = safeMap(data?.map);
    rankedQueue.push(p); socket.emit('queueStatus', { status: 'queued', message: 'Searching for an opponent…' });
    if (rankedQueue.length >= 2) { const first = rankedQueue.shift(), second = rankedQueue.shift(); if (first && second && first.id !== second.id) { const room = createRoom(first, first.queueMap, true); room.players.push(second); second.roomCode = room.code; second.socket.join(room.code); startMatch(room); } }
  });
  socket.on('leaveRankedQueue', () => { removeFromQueue(p.id); socket.emit('queueStatus', { status: 'left', message: 'Matchmaking cancelled.' }); });
  socket.on('createPrivateRoom', async data => {
    if (p.roomCode) { const currentRoom = rooms.get(p.roomCode); if (currentRoom) await finishMatch(currentRoom, 'forfeit', p.id); }
    p.color = safeColor(data?.color); const room = createRoom(p, data?.map, false);
    socket.emit('privateRoomCreated', { roomCode: room.code, map: room.map });
  });
  socket.on('joinPrivateRoom', data => {
    const room = rooms.get(String(data?.roomCode || '').trim().toUpperCase());
    if (!room || room.ranked || room.status !== 'waiting') return socket.emit('queueError', 'That room code is invalid or the room has already started.');
    if (room.players.length !== 1) return socket.emit('queueError', 'That room is full.');
    p.color = safeColor(data?.color); p.roomCode = room.code; p.socket.join(room.code); room.players.push(p);
    io.to(room.code).emit('privateRoomUpdate', { roomCode: room.code, waiting: false, message: 'Opponent joined. Starting match…' }); startMatch(room);
  });
  socket.on('fire', async data => {
    const room = rooms.get(p.roomCode); if (!room || room.status !== 'playing' || p.hp <= 0) return;
    const target = room.players.find(x => x.id !== p.id); if (!target || target.hp <= 0) return;
    const weapon = WEAPONS[data?.weapon] || WEAPONS.default; const angle = Number.isFinite(data?.angle) ? data.angle : p.angle;
    const dx = target.x - p.x, dy = target.y - p.y, dist = Math.hypot(dx,dy); const aim = Math.atan2(dy,dx);
    const diff = Math.atan2(Math.sin(aim-angle), Math.cos(aim-angle)); const threshold = Math.max(.035, Math.atan2(18, Math.max(1,dist))) + weapon.spread * .12;
    if (dist > weapon.range || Math.abs(diff) > threshold) return;
    target.hp = Math.max(0, target.hp - weapon.damage); target.socket.emit('playerDamaged', { hp: target.hp, from: p.name, damage: weapon.damage });
    io.to(room.code).emit('shotFired', { shooter: p.id, x: p.x, y: p.y, angle, color: p.color, damage: weapon.damage });
    if (target.hp <= 0) {
      p.kills++; target.deaths++;
      let killerProfile = { name: p.name, role: 'MATCH OPPONENT', bio: 'This operator eliminated you.' }; try { const kp = await readProfile(p.userId); const gs = kp?.game_state || {}; killerProfile = { name: p.name, pfp: gs.profilePfpUrl || '', banner: gs.profileBannerUrl || '', bannerColor: gs.profileBannerColor || '#57212a', role: gs.equippedOperator || 'MATCH OPPONENT', bio: gs.operatorBio || 'This operator eliminated you.' }; } catch (_) {} io.to(room.code).emit('playerKilled', { killer: p.id, killerName: p.name, killerProfile, victim: target.id, victimName: target.name, scores: room.players.map(x => ({ id: x.id, name: x.name, kills: x.kills, deaths: x.deaths })) });
      target.socket.emit('playerRespawnSoon', { delay: 1800 });
      setTimeout(() => { if (rooms.get(room.code) !== room || room.status !== 'playing') return; target.hp = 100; target.x = room.map === 'tiny' ? (target.id === room.players[0].id ? 130 : 770) : (target.id === room.players[0].id ? 500 : 3100); target.y = room.map === 'tiny' ? 350 : 1300; target.socket.emit('playerRespawn', { x: target.x, y: target.y, hp: 100 }); io.to(room.code).emit('playerMoved', publicPlayer(target)); }, 1800);
    }
    io.to(room.code).emit('playerStats', room.players.map(publicPlayer));
  });
  socket.on('getLeaderboard', async data => socket.emit('leaderboardData', { map: data?.map === 'all' ? 'all' : safeMap(data?.map), persistent: supabaseReady, rows: await getBoard(data?.map || 'all') }));
  socket.on('disconnect', () => { playerDisconnected(p); players.delete(socket.id); broadcastOnlinePlayers(); });
});
server.listen(PORT, '0.0.0.0', () => console.log(`LAST STAND ARENA server listening on ${PORT}`));
