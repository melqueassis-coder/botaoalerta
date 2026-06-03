const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

// Rota de status simples
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Servidor de Botões de Pânico está ativo.' });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  // Ping nativo do socket.io para manter conexão viva no servidor
  pingInterval: 20000,
  pingTimeout: 10000
});

// Estrutura para armazenar as salas ativas
// roomCode -> { elderlySocketId, elderlyName, caregivers: Map(socketId -> name), activeAlert, reconnectTimer }
const rooms = new Map();

// Mapeamento reverso: socketId -> roomCode
const socketToRoom = new Map();
// Mapeamento: socketId -> role ('elderly' | 'caregiver')
const socketRole = new Map();
// Mapeamento: elderlyName -> roomCode (para reconexão por nome)
const elderlyNameToRoom = new Map();

// Função para gerar um código de pareamento único de 6 dígitos
function generateRoomCode() {
  let code;
  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(code));
  return code;
}

// Função para broadcast do status de cuidadores na sala
function broadcastCaregiverStatus(code) {
  const room = rooms.get(code);
  if (!room) return;
  io.to(code).emit('caregiver-status', {
    connected: room.caregivers.size > 0,
    count: room.caregivers.size,
    caregiversList: Array.from(room.caregivers.values())
  });
}

io.on('connection', (socket) => {
  console.log(`Dispositivo conectado: ${socket.id}`);

  // ──────────────────────────────────────────────────────────
  // HEARTBEAT: responde ping para manter conexão viva
  // ──────────────────────────────────────────────────────────
  socket.on('ping', () => {
    socket.emit('pong');
  });

  // ──────────────────────────────────────────────────────────
  // 1. CRIAÇÃO DE SALA (Idoso)
  //    Suporta reconexão: se já existir uma sala para este idoso
  //    (detectada pelo nome), retoma a sala existente.
  // ──────────────────────────────────────────────────────────
  socket.on('create-room', ({ name, existingCode }) => {
    const elderlyName = name || 'Idoso';

    // Tenta reconectar a sala existente pelo código salvo no cliente
    if (existingCode && rooms.has(existingCode)) {
      const room = rooms.get(existingCode);

      // Cancela timer de expiração se existia
      if (room.reconnectTimer) {
        clearTimeout(room.reconnectTimer);
        room.reconnectTimer = null;
      }

      // Atualiza o socketId do idoso na sala
      room.elderlySocketId = socket.id;
      socketToRoom.set(socket.id, existingCode);
      socketRole.set(socket.id, 'elderly');
      socket.join(existingCode);

      console.log(`Idoso "${elderlyName}" reconectou à sala: ${existingCode}`);
      socket.emit('room-created', { code: existingCode });

      // Informa cuidadores que o idoso voltou
      broadcastCaregiverStatus(existingCode);

      // Se havia alerta ativo, reenvia para o idoso reconectado
      if (room.activeAlert) {
        socket.emit('receive-alert', room.activeAlert);
      }
      return;
    }

    // Cria nova sala normalmente
    const code = generateRoomCode();
    rooms.set(code, {
      elderlySocketId: socket.id,
      elderlyName: elderlyName,
      caregivers: new Map(),
      activeAlert: null,
      reconnectTimer: null
    });

    elderlyNameToRoom.set(elderlyName, code);
    socketToRoom.set(socket.id, code);
    socketRole.set(socket.id, 'elderly');
    socket.join(code);

    console.log(`Sala criada: ${code} pelo idoso: "${elderlyName}" (${socket.id})`);
    socket.emit('room-created', { code });
  });

  // ──────────────────────────────────────────────────────────
  // 2. ENTRAR NA SALA (Cuidador)
  //    Suporta reconexão: se o código já existe, re-entra.
  // ──────────────────────────────────────────────────────────
  socket.on('join-room', ({ code, name }) => {
    const cleanCode = code.toString().trim().replace(/\s/g, '');
    const room = rooms.get(cleanCode);

    if (!room) {
      console.log(`Cuidador ${socket.id} tentou sala inexistente: ${cleanCode}`);
      socket.emit('join-error', { message: 'Código de pareamento inválido ou expirado. Peça um novo código ao idoso.' });
      return;
    }

    const caregiverName = name || 'Cuidador';
    room.caregivers.set(socket.id, caregiverName);

    socketToRoom.set(socket.id, cleanCode);
    socketRole.set(socket.id, 'caregiver');
    socket.join(cleanCode);

    console.log(`Cuidador "${caregiverName}" (${socket.id}) entrou na sala: ${cleanCode}`);

    // Confirma pareamento com o cuidador
    socket.emit('joined-successfully', {
      code: cleanCode,
      elderlyName: room.elderlyName
    });

    // Atualiza status de cuidadores para todos na sala
    broadcastCaregiverStatus(cleanCode);

    // Se houver alerta ativo, envia imediatamente ao cuidador que acabou de entrar
    if (room.activeAlert) {
      socket.emit('receive-alert', room.activeAlert);
    }
  });

  // ──────────────────────────────────────────────────────────
  // 3. DISPARO DE ALERTA (Idoso)
  // ──────────────────────────────────────────────────────────
  socket.on('trigger-alert', ({ type }) => {
    const code = socketToRoom.get(socket.id);
    const role = socketRole.get(socket.id);

    if (!code || role !== 'elderly') {
      socket.emit('alert-error', { message: 'Apenas dispositivos de idosos pareados podem disparar alertas.' });
      return;
    }

    const room = rooms.get(code);
    if (room) {
      const alertData = {
        type,
        elderlyName: room.elderlyName,
        timestamp: new Date().toISOString()
      };
      room.activeAlert = alertData;
      io.to(code).emit('receive-alert', alertData);
      console.log(`Alerta "${type}" disparado na sala ${code} por "${room.elderlyName}"`);
    }
  });

  // ──────────────────────────────────────────────────────────
  // 4. CONFIRMAÇÃO DE ALERTA (Cuidador ou Idoso cancelando)
  // ──────────────────────────────────────────────────────────
  socket.on('acknowledge-alert', () => {
    const code = socketToRoom.get(socket.id);
    const role = socketRole.get(socket.id);

    if (!code) return;
    const room = rooms.get(code);
    if (!room || !room.activeAlert) return;

    room.activeAlert = null;

    if (role === 'elderly') {
      io.to(code).emit('alert-acknowledged', {
        by: 'elderly',
        byName: room.elderlyName,
        message: 'Cancelado pelo idoso.'
      });
    } else if (role === 'caregiver') {
      const caregiverName = room.caregivers.get(socket.id) || 'Cuidador';
      io.to(code).emit('alert-acknowledged', {
        by: socket.id,
        byName: caregiverName,
        message: `${caregiverName} está a caminho!`
      });
      console.log(`Alerta confirmado por "${caregiverName}" na sala: ${code}`);
    }
  });

  // ──────────────────────────────────────────────────────────
  // 5. DESCONEXÃO — Sala do IDOSO persiste por 3 minutos
  //    para permitir reconexão sem perder o código.
  // ──────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    const code = socketToRoom.get(socket.id);
    const role = socketRole.get(socket.id);

    socketToRoom.delete(socket.id);
    socketRole.delete(socket.id);

    if (!code) {
      console.log(`Dispositivo desconectado (sem sala): ${socket.id}`);
      return;
    }

    const room = rooms.get(code);
    if (!room) return;

    if (role === 'elderly') {
      console.log(`Idoso desconectou da sala ${code}. Aguardando reconexão por 3 minutos...`);

      // Avisa cuidadores que o idoso desconectou (temporariamente)
      io.to(code).emit('elderly-reconnecting');

      // Agenda exclusão da sala após 3 minutos
      room.reconnectTimer = setTimeout(() => {
        const roomStillExists = rooms.get(code);
        if (roomStillExists && roomStillExists.elderlySocketId === socket.id) {
          console.log(`Sala ${code} expirada após 3 min sem reconexão do idoso.`);
          io.to(code).emit('elderly-disconnected');
          rooms.delete(code);
          elderlyNameToRoom.delete(room.elderlyName);
        }
      }, 3 * 60 * 1000); // 3 minutos

    } else if (role === 'caregiver') {
      const name = room.caregivers.get(socket.id) || 'Cuidador';
      room.caregivers.delete(socket.id);
      console.log(`Cuidador "${name}" desconectou da sala ${code}. Restantes: ${room.caregivers.size}`);
      broadcastCaregiverStatus(code);
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Servidor de Botões de Pânico rodando na porta ${PORT}`);
});
