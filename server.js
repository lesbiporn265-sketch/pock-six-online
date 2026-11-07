const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 10000);
const MAX_PLAYERS = 6;
const STARTING_STACK = 1000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const TURN_MS = 45_000;
const rooms = new Map();

const app = express();
app.get("/", (_req, res) => res.json({ service: "pock-six-online", status: "ok", rooms: rooms.size }));
app.get("/health", (_req, res) => res.json({ ok: true, rooms: rooms.size }));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const uid = () => crypto.randomBytes(8).toString("hex");
const roomCode = () => crypto.randomBytes(3).toString("hex").toUpperCase();
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const send = (ws, message) => ws.readyState === 1 && ws.send(JSON.stringify(message));
const announce = (room, message) => room.players.forEach(p => send(p.ws, message));
const activePlayers = room => room.players.filter(p => !p.folded);
const contenders = room => activePlayers(room).filter(p => !p.allIn);

function freshRoom(code) {
  return { code, hostId: null, players: [], phase: "lobby", handNo: 0, dealer: 0, board: [], deck: [], pot: 0,
    currentBet: 0, minRaise: BIG_BLIND, turn: null, turnDeadline: null, timer: null, smallBlind: SMALL_BLIND, bigBlind: BIG_BLIND };
}
function newPlayer(ws, name, seat) {
  return { id: uid(), ws, name: String(name || "Player").trim().slice(0, 20) || "Player", seat,
    stack: STARTING_STACK, inHand: false, folded: false, allIn: false, hole: [], streetBet: 0, totalBet: 0, connected: true };
}
function makeDeck() {
  const cards = [];
  for (let suit = 0; suit < 4; suit++) for (let rank = 2; rank <= 14; rank++) cards.push({ rank, suit });
  for (let i = cards.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [cards[i], cards[j]] = [cards[j], cards[i]]; }
  return cards;
}
function publicPlayer(p) { return { id: p.id, name: p.name, seat: p.seat, stack: p.stack, inHand: p.inHand, folded: p.folded, allIn: p.allIn, connected: p.connected, streetBet: p.streetBet, totalBet: p.totalBet }; }
function snapshot(room, recipient) {
  return { type: "state", room: room.code, phase: room.phase, handNo: room.handNo, board: room.board,
    pot: room.pot, currentBet: room.currentBet, minRaise: room.minRaise, turn: room.turn,
    turnDeadline: room.turnDeadline, hostId: room.hostId, smallBlind: room.smallBlind, bigBlind: room.bigBlind,
    players: room.players.map(publicPlayer), you: recipient ? { id: recipient.id, seat: recipient.seat, hole: recipient.hole, stack: recipient.stack } : null };
}
function broadcastState(room) { room.players.forEach(p => send(p.ws, snapshot(room, p))); }
function error(ws, code, message) { send(ws, { type: "error", code, message }); }
function getRoom(ws) { return ws.player && rooms.get(ws.player.room); }
function getPlayer(ws) { return ws.player && getRoom(ws)?.players.find(p => p.id === ws.player.id); }
function notify(room, text) { announce(room, { type: "notice", text }); }

function joinRoom(ws, name, requestedCode) {
  const code = (requestedCode || roomCode()).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  let room = rooms.get(code);
  if (!room) { room = freshRoom(code); rooms.set(code, room); }
  if (room.players.length >= MAX_PLAYERS) return error(ws, "ROOM_FULL", "Room is full");
  if (room.phase !== "lobby") return error(ws, "HAND_ACTIVE", "A hand is already in progress");
  const used = new Set(room.players.map(p => p.seat));
  const seat = [0, 1, 2, 3, 4, 5].find(x => !used.has(x));
  const p = newPlayer(ws, name, seat);
  p.room = code; room.players.push(p); if (!room.hostId) room.hostId = p.id; ws.player = p;
  send(ws, { type: "joined", room: code, playerId: p.id, hostId: room.hostId });
  notify(room, `${p.name} joined the table`); broadcastState(room);
}
function leave(ws) {
  const room = getRoom(ws); const p = getPlayer(ws); if (!room || !p) return;
  room.players = room.players.filter(x => x.id !== p.id);
  if (room.hostId === p.id) room.hostId = room.players[0]?.id || null;
  if (!room.players.length) { clearTimeout(room.timer); rooms.delete(room.code); return; }
  if (room.phase !== "lobby" && p.inHand && !p.folded) { p.folded = true; maybeAdvance(room); }
  notify(room, `${p.name} left the table`); broadcastState(room);
}
function putChips(p, amount, room) {
  const paid = clamp(Math.floor(amount), 0, p.stack); p.stack -= paid; p.streetBet += paid; p.totalBet += paid; room.pot += paid;
  if (p.stack === 0) p.allIn = true; return paid;
}
function nextSeat(room, from, predicate) {
  for (let step = 1; step <= MAX_PLAYERS; step++) { const p = room.players[(from + step) % room.players.length]; if (p && predicate(p)) return p; }
  return null;
}
function startHand(room) {
  if (room.players.filter(p => p.connected).length < 2 || room.phase !== "lobby") return;
  room.phase = "preflop"; room.handNo++; room.board = []; room.deck = makeDeck(); room.pot = 0; room.currentBet = BIG_BLIND; room.minRaise = BIG_BLIND;
  room.players.forEach(p => { p.inHand = p.connected && p.stack > 0; p.folded = !p.inHand; p.allIn = false; p.hole = []; p.streetBet = 0; p.totalBet = 0; });
  room.dealer = room.players.findIndex(p => p.inHand && p.seat >= room.dealer) ; if (room.dealer < 0) room.dealer = 0;
  for (let round = 0; round < 2; round++) room.players.filter(p => p.inHand).forEach(p => p.hole.push(room.deck.pop()));
  const live = room.players.filter(p => p.inHand); const sb = live[(room.dealer + 1) % live.length]; const bb = live[(room.dealer + 2) % live.length];
  putChips(sb, room.smallBlind, room); putChips(bb, room.bigBlind, room); room.turn = nextSeat(room, bb.seat, p => p.inHand && !p.folded && !p.allIn)?.id || null;
  notify(room, `Hand #${room.handNo} started`); armTurn(room); broadcastState(room);
}
function armTurn(room) { clearTimeout(room.timer); const p = room.players.find(x => x.id === room.turn); if (!p) return; room.turnDeadline = Date.now() + TURN_MS; room.timer = setTimeout(() => { if (room.turn === p.id) applyAction(room, p, { action: p.streetBet < room.currentBet ? "fold" : "check" }); }, TURN_MS); }
function resetStreet(room, nextPhase) { room.players.forEach(p => p.streetBet = 0); room.currentBet = 0; room.minRaise = BIG_BLIND; room.phase = nextPhase; }
function dealBoard(room, count) { for (let i = 0; i < count; i++) room.board.push(room.deck.pop()); }
function advanceStreet(room) {
  if (room.phase === "preflop") { resetStreet(room, "flop"); dealBoard(room, 3); }
  else if (room.phase === "flop") { resetStreet(room, "turn"); dealBoard(room, 1); }
  else if (room.phase === "turn") { resetStreet(room, "river"); dealBoard(room, 1); }
  else if (room.phase === "river") return showdown(room);
  const first = nextSeat(room, room.dealer, p => p.inHand && !p.folded && !p.allIn);
  room.turn = first?.id || null; if (!room.turn) return advanceStreet(room); armTurn(room); broadcastState(room);
}
function maybeAdvance(room) {
  const live = activePlayers(room); if (live.length <= 1) return showdown(room);
  const canAct = contenders(room); const matched = canAct.every(p => p.streetBet === room.currentBet);
  if (canAct.length === 0 || matched && canAct.every(p => p.id !== room.turn)) return advanceStreet(room);
  if (matched && live.filter(p => !p.allIn).length === 1) return advanceStreet(room);
  armTurn(room); broadcastState(room);
}
function applyAction(room, p, data) {
  if (!p.inHand || p.folded || room.phase === "showdown" || room.turn !== p.id) return error(p.ws, "NOT_YOUR_TURN", "It is not your turn");
  const action = String(data.action || "").toLowerCase(); const toCall = Math.max(0, room.currentBet - p.streetBet); let paid = 0;
  if (action === "fold") p.folded = true;
  else if (action === "check" && toCall === 0) {}
  else if (action === "call" && toCall > 0) paid = putChips(p, toCall, room);
  else if ((action === "bet" || action === "raise") && Number.isFinite(Number(data.amount))) {
    const target = Math.floor(Number(data.amount)); const minTarget = room.currentBet ? room.currentBet + room.minRaise : BIG_BLIND;
    if (target < minTarget && target < p.streetBet + p.stack) return error(p.ws, "RAISE_TOO_SMALL", `Minimum total bet is ${minTarget}`);
    paid = putChips(p, target - p.streetBet, room); room.minRaise = Math.max(room.minRaise, target - room.currentBet); room.currentBet = Math.max(room.currentBet, p.streetBet);
  } else if (action === "all-in") { const before = room.currentBet; paid = putChips(p, p.stack, room); if (p.streetBet > before) { room.minRaise = Math.max(room.minRaise, p.streetBet - before); room.currentBet = p.streetBet; } }
  else return error(p.ws, "INVALID_ACTION", "Action is not legal in the current state");
  if (p.folded || paid >= 0) { const next = nextSeat(room, p.seat, x => x.inHand && !x.folded && !x.allIn); room.turn = next?.id || null; notify(room, `${p.name}: ${action}`); maybeAdvance(room); }
}
function rankFive(cards) {
  const ranks = cards.map(c => c.rank).sort((a,b) => b-a); const counts = new Map(); ranks.forEach(r => counts.set(r, (counts.get(r)||0)+1)); const groups = [...counts.entries()].sort((a,b) => b[1]-a[1] || b[0]-a[0]); const flush = cards.every(c => c.suit === cards[0].suit);
  const uniq = [...new Set(ranks)]; let straight = 0; if (uniq.includes(14)) uniq.push(1); for (let i=0;i<=uniq.length-5;i++) if (uniq[i]-uniq[i+4]===4) { straight=uniq[i]; break; }
  if (flush && straight) return [8,straight]; if (groups[0][1]===4) return [7,groups[0][0],groups[1][0]]; if (groups[0][1]===3 && groups[1][1]===2) return [6,groups[0][0],groups[1][0]]; if (flush) return [5,...ranks]; if (straight) return [4,straight]; if (groups[0][1]===3) return [3,groups[0][0],...ranks.filter(r=>r!==groups[0][0])]; if (groups[0][1]===2 && groups[1][1]===2) return [2,Math.max(groups[0][0],groups[1][0]),Math.min(groups[0][0],groups[1][0]),groups[2][0]]; if (groups[0][1]===2) return [1,groups[0][0],...ranks.filter(r=>r!==groups[0][0])]; return [0,...ranks];
}
function compare(a,b) { for (let i=0;i<Math.max(a.length,b.length);i++) if ((a[i]||0)!==(b[i]||0)) return (a[i]||0)-(b[i]||0); return 0; }
function scoreSeven(cards) { let best = null; for (let a=0;a<cards.length-4;a++) for (let b=a+1;b<cards.length-3;b++) for (let c=b+1;c<cards.length-2;c++) for (let d=c+1;d<cards.length-1;d++) for (let e=d+1;e<cards.length;e++) { const s=rankFive([cards[a],cards[b],cards[c],cards[d],cards[e]]); if (!best || compare(s,best)>0) best=s; } return best; }
function showdown(room) {
  clearTimeout(room.timer); room.phase = "showdown"; room.turn = null; const live = activePlayers(room); let winners = live.filter(p => !p.folded);
  if (winners.length > 1) { let best = null; winners.forEach(p => { p.score = scoreSeven([...p.hole, ...room.board]); if (!best || compare(p.score,best)>0) best=p.score; }); winners = winners.filter(p => compare(p.score,best)===0); }
  const share = Math.floor(room.pot / winners.length); winners.forEach(p => p.stack += share); const remainder = room.pot - share*winners.length; if (winners[0]) winners[0].stack += remainder;
  announce(room, { type: "showdown", winners: winners.map(p => p.id), board: room.board, pot: room.pot }); notify(room, `${winners.map(p=>p.name).join(", ")} won ${room.pot} chips`); room.pot = 0; room.players.forEach(p => { p.inHand=false; p.streetBet=0; }); broadcastState(room); setTimeout(() => { if (rooms.has(room.code)) { room.phase="lobby"; broadcastState(room); } }, 3500);
}

wss.on("connection", ws => {
  ws.on("message", raw => { let data; try { data=JSON.parse(raw); } catch { return error(ws,"BAD_JSON","Message must be JSON"); }
    if (data.type === "join") return joinRoom(ws, data.name, data.room);
    const room=getRoom(ws), p=getPlayer(ws); if (!room || !p) return error(ws,"NOT_JOINED","Join a room first");
    if (data.type === "start") { if (p.id !== room.hostId) return error(ws,"NOT_HOST","Only the host can start"); return startHand(room); }
    if (data.type === "action") return applyAction(room,p,data);
    if (data.type === "ping") return send(ws,{type:"pong"});
  });
  ws.on("close", () => { const p=getPlayer(ws); if (p) { p.connected=false; leave(ws); } });
});
server.listen(PORT, "0.0.0.0", () => console.log(`pock-six-online listening on ${PORT}`));
