const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

global.db = global.db || {};
global.db.werewolf = global.db.werewolf || {};

// --- UTILITY FUNCTIONS (Sesuai Bot WA) ---
const func = {
    pickRandom: (arr) => arr[Math.floor(Math.random() * arr.length)],
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};

function getVoteResult(votes) {
    const defaultResult = { data: [], winner: null, count: 0, tie: false };
    if (typeof votes !== 'object' || votes === null) return defaultResult;

    const voteCount = {};
    for (const [voterId, details] of Object.entries(votes)) {
        if (typeof details !== 'object' || details === null) continue;
        const count = typeof details.count === 'number' ? details.count : 1;
        const votingValue = details.voting;
        if (votingValue === undefined) continue;
        voteCount[votingValue] = (voteCount[votingValue] || 0) + count;
    }

    let maxVote = 0;
    const winners = [];
    for (const [candidate, count] of Object.entries(voteCount)) {
        if (count > maxVote) {
            maxVote = count;
            winners.length = 0;
            winners.push(candidate);
        } else if (count === maxVote) {
            winners.push(candidate);
        }
    }

    return { data: Object.entries(voteCount), winner: winners.length > 0 ? winners[0] : null, count: maxVote, tie: winners.length > 1 };
}

const roleShuffle = (array) => {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
};

const roleAmount = (playerCount) => {
    if (playerCount < 6 || playerCount > 12) return false;
    return {
        werewolf: 2,
        seer: 1,
        guard: playerCount >= 10 || playerCount === 6 || playerCount === 7 ? 1 : 0,
        hunter: playerCount >= 8 ? 1 : 0,
        witch: playerCount >= 8 ? 1 : 0,
        traitor: playerCount >= 8 ? 1 : 0,
        lycan: playerCount >= 10 ? 1 : 0,
        villager: playerCount - (2 + 1 + (playerCount >= 10 || playerCount === 6 || playerCount === 7 ? 1 : 0) + (playerCount >= 8 ? 3 : 0) + (playerCount >= 10 ? 1 : 0))
    };
};

const livingPlayers = (roomId) => {
    const room = global.db.werewolf[roomId];
    return room ? room.player.filter(x => !x.isdead) : [];
};

const checkTraitor = (roomId) => {
    const room = global.db.werewolf[roomId];
    if (!room) return;
    const livingWW = room.player.filter(p => p.role === 'werewolf' && !p.isdead);
    if (livingWW.length === 0) {
        const traitor = room.player.find(p => p.role === 'traitor' && !p.isdead);
        if (traitor) {
            traitor.role = 'werewolf';
            io.to(traitor.id).emit('gameLog', `😈 Semua Werewolf telah mati. Kamu sebagai Traitor kini berubah menjadi Werewolf!`);
        }
    }
};

const getWinner = (roomId) => {
    const room = global.db.werewolf[roomId];
    if (!room) return { status: null };

    const living = livingPlayers(roomId);
    const livingWerewolves = living.filter(p => p.role === 'werewolf');
    const livingVillagers = living.filter(p => p.role !== 'werewolf');

    if (livingWerewolves.length === 0) {
        const hasTraitor = room.player.some(p => p.role === 'traitor' && !p.isdead);
        if (hasTraitor && livingVillagers.length > 1) return { status: false };
        return { status: true }; // Warga menang
    }

    if (livingWerewolves.length >= livingVillagers.length) {
        const hunterAlive = living.find(p => p.role === 'hunter');
        if (livingVillagers.length === 1 && hunterAlive && livingWerewolves.length === 1) return { status: true };
        return { status: false }; // Werewolf menang
    }

    return { status: null };
};

const killPlayer = (roomId, id) => {
    const room = global.db.werewolf[roomId];
    if (!room) return;
    const player = room.player.find(p => p.id === id);
    if (player) player.isdead = true;
    checkTraitor(roomId);
};

// --- LOGIKA AI (Di-porting dari Bot WA) ---
const addAIPlayers = (roomId, count) => {
    const room = global.db.werewolf[roomId];
    if (!room) return;
    for (let i = 1; i <= count; i++) {
        const aiId = `ai_${crypto.randomBytes(4).toString('hex')}`;
        room.player.push({
            id: aiId, name: `🤖 AI-${room.player.length + 1}`, number: room.player.length + 1,
            status: false, role: false, originalRole: false, effect: [], isdead: false, potions: { elixir: 1, poison: 1 },
            knowledge: { suspected: [], knownGood: [], knownBad: [], votersAgainstWW: [] }
        });
    }
};

const simulateAIVotes = (roomId, phase) => {
    const room = global.db.werewolf[roomId];
    if (!room) return;

    const living = livingPlayers(roomId);
    const aiPlayers = living.filter(p => p.id.startsWith('ai_'));
    const badRoles = ['werewolf'];

    // Update Knowledge
    if (room.voting_werewolf) {
        const prevVotes = getVoteResult(room.voting_werewolf);
        if (prevVotes.winner) {
            aiPlayers.forEach(ai => {
                if (!ai.knowledge.suspected.includes(prevVotes.winner)) ai.knowledge.suspected.push(prevVotes.winner);
            });
        }
    }

    for (let ai of aiPlayers) {
        if (ai.status && phase !== 'mayor' && phase !== 'voting') continue;

        let target = null;
        const otherLiving = living.filter(p => p.id !== ai.id);
        if (otherLiving.length === 0) continue;

        if (phase === 'mayor') {
            target = func.pickRandom(otherLiving).id;
            room.select_village_head[ai.id] = { voting: target };
        } else if (phase === 'voting') {
            const suspectedTargets = ai.knowledge.suspected.map(s => living.find(l => l.id === s)).filter(Boolean);
            target = func.pickRandom(suspectedTargets.length ? suspectedTargets : otherLiving).id;
            room.voting_werewolf[ai.id] = { voting: target, count: room.village_head === ai.id ? 2 : 1 };
        } else if (phase === 'malem') {
            switch (ai.role) {
                case 'werewolf':
                    let humanVote = null;
                    let existingVote = null;
                    for (const [voterId, details] of Object.entries(room.werewolf_vote)) {
                        if (!voterId.startsWith('ai_')) humanVote = details.voting;
                        else if (!existingVote) existingVote = details.voting;
                    }
                    if (humanVote) target = humanVote;
                    else if (existingVote) target = existingVote;
                    else {
                        const nonWWTargets = living.filter(p => p.role !== 'werewolf');
                        target = func.pickRandom(nonWWTargets).id;
                    }
                    room.werewolf_vote[ai.id] = { voting: target };
                    break;
                case 'seer':
                    target = func.pickRandom(otherLiving).id;
                    room.seer_vote = target;
                    const isBad = badRoles.includes(room.player.find(p => p.id === target).role) || room.player.find(p => p.id === target).role === 'lycan';
                    ai.knowledge[isBad ? 'knownBad' : 'knownGood'].push(target);
                    break;
                case 'guard':
                    const mayorAlive = living.find(p => p.id === room.village_head);
                    target = (Math.random() > 0.6) ? ai.id : (mayorAlive ? mayorAlive.id : func.pickRandom(living).id);
                    room.player.find(p => p.id === target).effect.push("guard");
                    room.guard_vote = target;
                    break;
                case 'hunter':
                    target = func.pickRandom(otherLiving).id;
                    room.hunter_vote = target;
                    break;
                case 'witch':
                    if (room.day > 1) {
                        if (ai.potions.poison > 0 && Math.random() > 0.3) {
                            target = func.pickRandom(otherLiving).id;
                            room.player.find(p => p.id === target).effect.push("poison");
                            ai.potions.poison--;
                        } else if (ai.potions.elixir > 0) {
                            room.player.find(p => p.id === ai.id).effect.push("elixir");
                            ai.potions.elixir--;
                        }
                    }
                    break;
            }
            ai.status = true;
        }
    }
};

const broadcastState = (roomId) => {
    const room = global.db.werewolf[roomId];
    if (!room) return;
    const safeRoomData = {
        time: room.time, day: room.day, status: room.status, village_head: room.village_head,
        player: room.player.map(p => ({
            id: p.id, name: p.name, number: p.number, isdead: p.isdead, role: p.role, 
            potions: p.potions, isMayor: room.village_head === p.id 
        }))
    };
    io.to(roomId).emit('updateState', safeRoomData);
};

// --- GAME ENGINE (STATE MACHINE) ---
const processGamePhase = async (roomId) => {
    const room = global.db.werewolf[roomId];
    if (!room || !room.status) return;

    if (room.time === 'mayor') {
        simulateAIVotes(roomId, 'mayor');
        const voters = getVoteResult(room.select_village_head);
        
        let kadesId = (voters.data.length > 0 && !voters.tie) ? voters.winner : func.pickRandom(room.player).id;
        room.village_head = kadesId;
        const kadesName = room.player.find(p=>p.id === kadesId).name;

        io.to(roomId).emit('gameLog', `👑 Pemilihan selesai! ${kadesName} terpilih sebagai Kepala Desa. Vote-nya akan dihitung 2x.`);
        room.time = 'malem';
        room.day = 1;
        
        setTimeout(() => {
            io.to(roomId).emit('gameLog', `🌙 Hari Pertama. Malam telah tiba. Semua peran silakan beraksi.`);
            broadcastState(roomId);
            setTimeout(() => processGamePhase(roomId), 30000); // Durasi malam 30 detik
        }, 5000);
        broadcastState(roomId);

    } else if (room.time === 'malem') {
        simulateAIVotes(roomId, 'malem');
        
        // Eksekusi Pagi
        room.time = 'pagi';
        let pagiLog = `🌅 Hari ke-${room.day}. Matahari terbit.\n`;
        
        let deadPlayerId = null;
        const wwVotes = getVoteResult(room.werewolf_vote);
        if (wwVotes.winner) deadPlayerId = wwVotes.winner;

        const deadPlayer = room.player.find(x => x.id === deadPlayerId);
        const poisonedPlayer = room.player.find(x => x.effect.includes("poison"));
        const hunterTargetId = room.hunter_vote;

        if (deadPlayer) {
            if (deadPlayer.effect.includes("guard")) {
                pagiLog += `🛡️ Seseorang diserang Werewolf, tapi diselamatkan oleh Guard!\n`;
            } else if (deadPlayer.effect.includes("elixir")) {
                pagiLog += `🧪 Seseorang diserang Werewolf, tapi disembuhkan oleh Witch!\n`;
            } else {
                killPlayer(roomId, deadPlayer.id);
                pagiLog += `🐺 ${deadPlayer.name} tewas dicabik-cabik Werewolf.\n`;
            }
        } else {
            pagiLog += `Damai. Tidak ada serangan dari Werewolf semalam.\n`;
        }

        if (poisonedPlayer) {
            killPlayer(roomId, poisonedPlayer.id);
            pagiLog += `🤢 ${poisonedPlayer.name} ditemukan tewas dengan mulut berbusa karena racun Witch.\n`;
        }

        const isHunterDead = (deadPlayer && deadPlayer.role === 'hunter' && deadPlayer.isdead) || (poisonedPlayer && poisonedPlayer.role === 'hunter' && poisonedPlayer.isdead);
        if (isHunterDead && hunterTargetId) {
            const hTarget = room.player.find(p => p.id === hunterTargetId);
            if (hTarget && !hTarget.isdead) {
                killPlayer(roomId, hTarget.id);
                pagiLog += `🎯 Hunter yang sekarat melepaskan tembakan terakhir dan membunuh ${hTarget.name}!\n`;
            }
        }

        io.to(roomId).emit('gameLog', pagiLog.trim());
        
        // Reset efek semalam
        room.player.forEach(p => { p.effect = []; p.status = false; });
        room.werewolf_vote = {}; room.guard_vote = null; room.seer_vote = null; room.hunter_vote = null;
        
        const winCheck = getWinner(roomId);
        if (winCheck.status !== null) return endGame(roomId, winCheck.status);

        setTimeout(() => {
            if(room.status) {
                room.time = 'voting';
                io.to(roomId).emit('gameLog', `☀️ Waktunya diskusi! Siapa Werewolf di antara kalian? (Kepala Desa vote 2x)`);
                broadcastState(roomId);
                setTimeout(() => processGamePhase(roomId), 30000); // Durasi Voting siang 30 detik
            }
        }, 8000);
        broadcastState(roomId);

    } else if (room.time === 'voting') {
        simulateAIVotes(roomId, 'voting');
        
        const dayVotes = getVoteResult(room.voting_werewolf);
        let soreLog = `⚖️ Hasil Voting:\n`;
        
        if (dayVotes.winner && !dayVotes.tie) {
            const dieTarget = room.player.find(p => p.id === dayVotes.winner);
            killPlayer(roomId, dieTarget.id);
            soreLog += `Warga sepakat menggantung ${dieTarget.name} (${dieTarget.role === 'lycan' ? 'villager' : dieTarget.role}).`;
            // Lycan tetap terlihat sebagai role aslinya saat mati, atau warga.
        } else {
            soreLog += `Voting seri atau kosong. Tidak ada yang dieksekusi hari ini.`;
        }
        
        io.to(roomId).emit('gameLog', soreLog);
        room.voting_werewolf = {};
        room.player.forEach(p => p.status = false);

        const winCheck = getWinner(roomId);
        if (winCheck.status !== null) return endGame(roomId, winCheck.status);

        room.time = 'malem';
        room.day += 1;
        setTimeout(() => {
            io.to(roomId).emit('gameLog', `🌙 Malam ke-${room.day} tiba. Para peran silakan beraksi.`);
            broadcastState(roomId);
            setTimeout(() => processGamePhase(roomId), 30000);
        }, 5000);
        broadcastState(roomId);
    }
};

const endGame = (roomId, isGoodWin) => {
    const room = global.db.werewolf[roomId];
    if (!room) return;
    room.status = false;
    let msg = isGoodWin ? `🎉 PERMAINAN BERAKHIR! TIM BAIK MENANG!` : `🩸 PERMAINAN BERAKHIR! WEREWOLF MENANG!`;
    io.to(roomId).emit('gameLog', msg);
    broadcastState(roomId);
};

// --- KONEKSI SOCKET.IO ---
io.on('connection', (socket) => {
    let sessionId = socket.handshake.auth.sessionId || crypto.randomUUID();
    socket.emit('session', { sessionId: sessionId, userId: sessionId });

    socket.on('joinRoom', ({ roomId, playerName }) => {
        socket.join(roomId);
        socket.roomId = roomId;
        socket.userId = sessionId;

        if (!global.db.werewolf[roomId]) {
            global.db.werewolf[roomId] = {
                room: roomId, status: false, day: 1, time: "menunggu", player: [],
                select_village_head: {}, voting_werewolf: {}, werewolf_vote: {}, village_head: null
            };
        }
        
        const room = global.db.werewolf[roomId];
        if (!room.player.find(p => p.id === sessionId)) {
            room.player.push({
                id: sessionId, name: playerName, number: room.player.length + 1,
                status: false, role: false, originalRole: false, effect: [], isdead: false, potions: { elixir: 1, poison: 1 }, knowledge: {}
            });
            io.to(roomId).emit('gameLog', `👋 ${playerName} bergabung ke dalam desa.`);
        }
        broadcastState(roomId);
    });

    socket.on('startGame', async ({ roomId }) => {
        const room = global.db.werewolf[roomId];
        if (!room || room.status) return;

        const totalPlayersCount = room.player.length;
        if (totalPlayersCount < 6) {
            addAIPlayers(roomId, 6 - totalPlayersCount);
            io.to(roomId).emit('gameLog', `🤖 Sistem menambahkan ${6 - totalPlayersCount} AI otomatis.`);
        }

        room.status = true;
        room.time = 'mayor';
        room.day = 1;
        room.select_village_head = {}; room.voting_werewolf = {}; room.werewolf_vote = {};
        
        const rolesConfig = roleAmount(room.player.length);
        const roleArray = [];
        for (const [r, count] of Object.entries(rolesConfig)) {
            for(let i=0; i<count; i++) roleArray.push(r);
        }
        const shuffledRoles = roleShuffle(roleArray);
        
        room.player.forEach((p, i) => { 
            p.role = shuffledRoles[i]; 
            p.originalRole = shuffledRoles[i]; 
            p.isdead = false; p.status = false; 
            p.potions = {elixir: 1, poison: 1};
            p.effect = [];
        });

        io.to(roomId).emit('gameLog', `🗳️ Pemilu Dimulai! Silakan vote siapa yang pantas menjadi Kepala Desa.`);
        broadcastState(roomId);
        
        // Memulai State Machine
        setTimeout(() => processGamePhase(roomId), 15000); // 15 Detik untuk milih Kades
    });

    // Handle aksi Player termasuk skill Potion Witch
    socket.on('playerAction', ({ roomId, targetId, actionType }) => {
        const room = global.db.werewolf[roomId];
        if (!room) return;
        
        const player = room.player.find(p => p.id === socket.userId);
        if (!player || player.isdead || player.status) return;

        if (room.time === 'mayor') {
            room.select_village_head[player.id] = { voting: targetId };
            socket.emit('gameLog', `✅ Kamu memvoting kandidat Kepala Desa.`);
            player.status = true;
        } else if (room.time === 'voting') {
            room.voting_werewolf[player.id] = { voting: targetId, count: room.village_head === player.id ? 2 : 1 };
            socket.emit('gameLog', `✅ Kamu memvoting untuk menggantung warga.`);
            player.status = true;
        } else if (room.time === 'malem') {
            const target = room.player.find(p => p.id === targetId);
            if(player.role === 'werewolf') {
                room.werewolf_vote[player.id] = { voting: targetId };
                socket.emit('gameLog', `🐺 Kamu menargetkan warga tersebut.`);
            } else if (player.role === 'seer') {
                room.seer_vote = targetId;
                const isBad = target.role === 'werewolf' || target.role === 'lycan';
                socket.emit('gameLog', `🔮 Hasil terawangan: Dia adalah tim ${isBad ? 'JAHAT' : 'BAIK'}.`);
            } else if (player.role === 'guard') {
                room.guard_vote = targetId;
                target.effect.push("guard");
                socket.emit('gameLog', `🛡️ Kamu menjaga warga tersebut malam ini.`);
            } else if (player.role === 'hunter') {
                room.hunter_vote = targetId;
                socket.emit('gameLog', `🎯 Kamu menandai target tersebut.`);
            } else if (player.role === 'witch') {
                if (room.day === 1) return socket.emit('gameLog', `❌ Witch tidak bisa pakai potion di hari pertama.`);
                
                if (actionType === 'elixir' && player.potions.elixir > 0) {
                    target.effect.push("elixir");
                    player.potions.elixir--;
                    socket.emit('gameLog', `🧪 Kamu menyelamatkan warga tersebut dengan Elixir.`);
                } else if (actionType === 'poison' && player.potions.poison > 0) {
                    target.effect.push("poison");
                    player.potions.poison--;
                    socket.emit('gameLog', `☠️ Kamu meracuni warga tersebut.`);
                } else {
                    return socket.emit('gameLog', `❌ Potion sudah habis atau tidak valid.`);
                }
            }
            player.status = true;
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🐺 Server Werewolf Elite menyala di port ${PORT}`);
});
