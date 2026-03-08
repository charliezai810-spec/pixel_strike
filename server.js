const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // 允許所有來源連線，方便雲端測試
        methods: ["GET", "POST"]
    }
});

// 提供靜態檔案
app.use(express.static(__dirname));

let waitingPlayer = null;

io.on('connection', (socket) => {
    console.log('玩家連線:', socket.id);

    socket.on('joinMatch', () => {
        if (waitingPlayer && waitingPlayer !== socket) {
            const room = 'room_' + socket.id;
            socket.join(room);
            waitingPlayer.join(room);
            io.to(room).emit('matchFound', { room: room });
            waitingPlayer = null;
        } else {
            waitingPlayer = socket;
            socket.emit('waitingForOpponent');
        }
    });

    socket.on('sendGarbage', (data) => {
        socket.to(data.room).emit('receiveGarbage', { type: data.type });
    });

    socket.on('disconnect', () => {
        if (waitingPlayer === socket) {
            waitingPlayer = null;
        }
    });
});

// 雲端平台會自動提供 process.env.PORT
const PORT = process.env.PORT || 8001;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`伺服器正在執行於 Port: ${PORT}`);
});
