const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto'); // Untuk membuat ID unik

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Sajikan file index.html ke browser
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Database Global (Sama seperti di bot WhatsApp kamu)
global.db = global.db || {};
global.db.werewolf = global.db.werewolf || {};

// Utility Functions
const func = {
    pickRandom: (arr) => arr[Math.floor(Math.random() * arr.length)],
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
};

function getVoteResult(votes) {
    const defaultResult = { data: [], winner: null, count: 0, tie: false };
    if (typeof votes !== 'object' || votes === null) return defaultResult;

    const voteCount = {};
    for (const [voterId, details] of Object.entries(votes)) {
        if (!details || details.voting === undefined) continue;
        const count = details.count || 1;
        voteCount[details.voting] = (voteCount[details.voting] || 0) + count;
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

// --- LOGIKA GAME UTAMA ---

// Memasukkan AI (Sesuai request versi Werewolf-AI)
const addAIPlayers = (roomId, count) => {
    const room = global.db.werewolf[roomId];
    if (!room) return;
    for (let i = 1; i <= count; i++) {
        const aiId = `ai_${crypto.randomBytes(4).toString('hex')}`;
        room.player.push({
            id: aiId, name: `🤖 AI-${room.player.length + 1}`, number: room.player.length + 1, 
            status: false, role: false, effect: [], isdead: false, potions: { elixir: 1, poison: 1 },
            knowledge: { suspected: [], knownGood: [], knownBad: [], votersAgainstWW: [] }
        });
    }
};

// Simulasi AI Vote (Disederhanakan untuk contoh web)
const simulateAIVotes = (roomId, phase) => {
    const room = global.db.werewolf[roomId];
    if (!room) return;
    const living = room.player.filter(p => !p.isdead);
    const aiPlayers = living.filter(p => p.id.startsWith('ai_'));

    for (let ai of aiPlayers) {
        if (ai.status && phase !== 'day') continue;
        const otherLiving = living.filter(p => p.id !== ai.id);
        if (otherLiving.length === 0) continue;

        let target = func.pickRandom(otherLiving).id;

        if (phase === 'day') {
            room.voting_werewolf[ai.id] = { voting: target, count: 1 };
        } else if (phase === 'night') {
            if (ai.role === 'werewolf') room.werewolf_vote[ai.id] = { voting: target };
            else if (ai.role === 'seer') room.seer_vote = target;
            else if (ai.role === 'guard') room.guard_vote = target;
            ai.status = true;
        }
    }
};

// Fungsi Broadcast untuk mengirim update layar ke semua pemain di Room
const broadcastState = (roomId) => {
    const room = global.db.werewolf[roomId];
    if (!room) return;
    // Bersihkan data sensitif (role asli pemain lain) sebelum dikirim ke Client agar tidak bisa di-cheat
    const safeRoomData = {
        time: room.time, day: room.day, status: room.status,
        player: room.player.map(p => ({
            id: p.id, name: p.name, number: p.number, isdead: p.isdead, role: p.role // Di produksi nyata, role orang lain disembunyikan
        }))
    };
    io.to(roomId).emit('updateState', safeRoomData);
};

// --- KONEKSI SOCKET.IO ---
io.on('connection', (socket) => {
    // 1. PEMULIHAN SESI (Session Recovery)
    let sessionId = socket.handshake.auth.sessionId;
    if (!sessionId) {
        sessionId = crypto.randomUUID(); // Buat ID baru jika belum punya
    }
    socket.emit('session', { sessionId: sessionId, userId: sessionId });

    // 2. JOIN ROOM
    socket.on('joinRoom', ({ roomId, playerName }) => {
        socket.join(roomId);
        socket.roomId = roomId;
        socket.userId = sessionId;

        if (!global.db.werewolf[roomId]) {
            global.db.werewolf[roomId] = {
                room: roomId, status: false, day: 1, time: "menunggu", player: [],
                isdead: null, voting_werewolf: {}, werewolf_vote: {}
            };
        }
        
        const room = global.db.werewolf[roomId];
        
        // Tambahkan pemain jika belum ada di dalam room
        if (!room.player.find(p => p.id === sessionId)) {
            room.player.push({
                id: sessionId, name: playerName, number: room.player.length + 1,
                status: false, role: false, effect: [], isdead: false, potions: { elixir: 1, poison: 1 }, knowledge: {}
            });
            io.to(roomId).emit('gameLog', `👋 ${playerName} bergabung ke dalam desa.`);
        } else {
            // Pemulihan sesi: Beritahu bahwa dia kembali terhubung
            socket.emit('gameLog', `🔄 Berhasil memulihkan sesi permainan.`);
        }
        
        broadcastState(roomId);
    });

    // 3. START GAME & GAME LOOP
    socket.on('startGame', async ({ roomId }) => {
        const room = global.db.werewolf[roomId];
        if (!room || room.status) return;

        // Tambah AI otomatis jika pemain kurang dari 6
        const humanCount = room.player.filter(p => !p.id.startsWith('ai_')).length;
        if (humanCount < 6) {
            addAIPlayers(roomId, 6 - humanCount);
            io.to(roomId).emit('gameLog', `🤖 Sistem menambahkan ${6 - humanCount} AI.`);
        }

        room.status = true;
        room.time = 'malem';
        
        // Bagi Role Acak
        const roles = ['werewolf', 'werewolf', 'seer', 'guard', 'villager', 'villager']; // Contoh statis untuk 6 player
        const shuffledRoles = roleShuffle(roles);
        room.player.forEach((p, i) => { p.role = shuffledRoles[i]; });

        io.to(roomId).emit('gameLog', `🌙 Hari Pertama. Malam telah tiba. Warga desa terlelap.`);
        broadcastState(roomId);

        // GAME LOOP SEDERHANA (Diatur pakai SetTimeout pengganti createDelay)
        const gameLoop = setInterval(() => {
            const currentRoom = global.db.werewolf[roomId];
            if (!currentRoom || !currentRoom.status) return clearInterval(gameLoop);

            if (currentRoom.time === 'malem') {
                simulateAIVotes(roomId, 'night');
                
                // Eksekusi Malam (Sederhana)
                let killTargetId = null;
                const wwVotes = getVoteResult(currentRoom.werewolf_vote);
                if (wwVotes.winner) killTargetId = wwVotes.winner;

                currentRoom.time = 'pagi';
                currentRoom.day += 1;
                
                let pagiLog = `🌅 Pagi Hari ke-${currentRoom.day}.\n`;
                if (killTargetId) {
                    const target = currentRoom.player.find(p => p.id === killTargetId);
                    if (currentRoom.guard_vote === killTargetId) {
                        pagiLog += `🛡️ Seseorang diserang, namun berhasil dilindungi oleh Guard!`;
                    } else {
                        target.isdead = true;
                        pagiLog += `💀 ${target.name} ditemukan tewas tercabik-cabik.`;
                    }
                } else {
                    pagiLog += `Damai. Tidak ada korban semalam.`;
                }

                io.to(roomId).emit('gameLog', pagiLog);
                currentRoom.werewolf_vote = {}; // Reset vote malam
                currentRoom.guard_vote = null;
                
                // Lanjut ke fase voting (Siang) setelah 10 detik
                setTimeout(() => {
                    if(currentRoom.status) {
                        currentRoom.time = 'voting';
                        io.to(roomId).emit('gameLog', `☀️ Waktunya berdiskusi! Silakan vote siapa yang dicurigai sebagai Werewolf.`);
                        broadcastState(roomId);
                    }
                }, 10000);

            } else if (currentRoom.time === 'voting') {
                simulateAIVotes(roomId, 'day');
                
                const dayVotes = getVoteResult(currentRoom.voting_werewolf);
                let soreLog = `⚖️ Hasil Voting:\n`;
                
                if (dayVotes.winner && !dayVotes.tie) {
                    const dieTarget = currentRoom.player.find(p => p.id === dayVotes.winner);
                    dieTarget.isdead = true;
                    soreLog += `Warga sepakat menggantung ${dieTarget.name} (${dieTarget.role}).`;
                } else {
                    soreLog += `Voting seri atau kosong. Warga bubar tanpa eksekusi.`;
                }
                
                io.to(roomId).emit('gameLog', soreLog);
                currentRoom.voting_werewolf = {}; // Reset vote siang
                
                // Cek Pemenang (Sederhana)
                const livingWW = currentRoom.player.filter(p => p.role === 'werewolf' && !p.isdead).length;
                const livingWarga = currentRoom.player.filter(p => p.role !== 'werewolf' && !p.isdead).length;
                
                if (livingWW === 0) {
                    io.to(roomId).emit('gameLog', `🎉 PERMAINAN BERAKHIR! TIM BAIK MENANG!`);
                    currentRoom.status = false;
                } else if (livingWW >= livingWarga) {
                    io.to(roomId).emit('gameLog', `🩸 PERMAINAN BERAKHIR! WEREWOLF MENANG!`);
                    currentRoom.status = false;
                } else {
                    currentRoom.time = 'malem';
                    setTimeout(() => {
                        io.to(roomId).emit('gameLog', `🌙 Malam tiba kembali. Para peran silakan beraksi.`);
                        broadcastState(roomId);
                    }, 5000);
                }
            }
            broadcastState(roomId);
        }, 30000); // Tiap fase berlangsung 30 detik
    });

    // 4. PLAYER ACTION (Vote / Skill)
    socket.on('playerAction', ({ roomId, targetId }) => {
        const room = global.db.werewolf[roomId];
        if (!room) return;
        
        const player = room.player.find(p => p.id === socket.userId);
        if (!player || player.isdead) return;

        if (room.time === 'voting') {
            room.voting_werewolf[player.id] = { voting: targetId, count: 1 };
            socket.emit('gameLog', `✅ Kamu memvoting salah satu warga.`);
        } else if (room.time === 'malem' && !player.status) {
            if (player.role === 'werewolf') {
                room.werewolf_vote[player.id] = { voting: targetId };
                socket.emit('gameLog', `🐺 Kamu menargetkan cakar pada warga.`);
            } else if (player.role === 'guard') {
                room.guard_vote = targetId;
                socket.emit('gameLog', `👼 Kamu melindungi target tersebut malam ini.`);
            }
            player.status = true;
        }
    });
});

// Jalankan Server
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🐺 Werewolf Web Server menyala di port ${PORT}`);
});