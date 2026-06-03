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
    origin: '*', // Permite conexões de qualquer origem para facilitar testes locais e deploy
    methods: ['GET', 'POST']
  }
});

// Estrutura para armazenar as salas ativas
// roomCode -> { elderlySocketId, caregivers: Set(socketId), activeAlert: null }
const rooms = new Map();

// Mapeamento de socketId -> roomCode para limpeza rápida na desconexão
const socketToRoom = new Map();
// Mapeamento de socketId -> role ('elderly' | 'caregiver')
const socketRole = new Map();

// Função para gerar um código de pareamento único de 6 dígitos
function generateRoomCode() {
  let code;
  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(code));
  return code;
}

io.on('connection', (socket) => {
  console.log(`Dispositivo conectado: ${socket.id}`);

  // 1. Registro do Idoso (Criação de Sala)
  socket.on('create-room', () => {
    const code = generateRoomCode();
    
    rooms.set(code, {
      elderlySocketId: socket.id,
      caregivers: new Set(),
      activeAlert: null
    });

    socketToRoom.set(socket.id, code);
    socketRole.set(socket.id, 'elderly');
    
    socket.join(code);
    
    console.log(`Sala criada: ${code} pelo idoso: ${socket.id}`);
    socket.emit('room-created', { code });
  });

  // 2. Registro do Cuidador (Entrar na Sala do Idoso)
  socket.on('join-room', ({ code }) => {
    const cleanCode = code.toString().trim().replace(/\s/g, '');
    const room = rooms.get(cleanCode);

    if (!room) {
      console.log(`Cuidador ${socket.id} tentou entrar em sala inexistente: ${cleanCode}`);
      socket.emit('join-error', { message: 'Código de pareamento inválido ou expirado.' });
      return;
    }

    room.caregivers.add(socket.id);
    socketToRoom.set(socket.id, cleanCode);
    socketRole.set(socket.id, 'caregiver');
    
    socket.join(cleanCode);
    
    console.log(`Cuidador ${socket.id} entrou na sala: ${cleanCode}`);
    
    // Notifica o cuidador que o pareamento deu certo
    socket.emit('joined-successfully', { code: cleanCode });
    
    // Notifica todos na sala que um cuidador se conectou
    io.to(cleanCode).emit('caregiver-status', { 
      connected: true, 
      count: room.caregivers.size 
    });

    // Se houver um alerta ativo na sala, envia imediatamente para o novo cuidador
    if (room.activeAlert) {
      socket.emit('receive-alert', room.activeAlert);
    }
  });

  // 3. Disparo de Alerta (Enviado pelo Idoso)
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
        type, // 'ajuda' (amigável) ou 'socorro' (emergência)
        timestamp: new Date().toISOString()
      };
      
      room.activeAlert = alertData;
      
      // Envia o alerta para todos na sala (incluindo o próprio idoso e todos os cuidadores)
      io.to(code).emit('receive-alert', alertData);
      console.log(`Alerta de ${type} disparado na sala: ${code}`);
    }
  });

  // 4. Confirmação/Acknowledge de Alerta (Enviado pelo Cuidador)
  socket.on('acknowledge-alert', () => {
    const code = socketToRoom.get(socket.id);
    const role = socketRole.get(socket.id);

    if (!code || role !== 'caregiver') {
      socket.emit('alert-error', { message: 'Apenas cuidadores pareados podem confirmar alertas.' });
      return;
    }

    const room = rooms.get(code);
    if (room && room.activeAlert) {
      room.activeAlert = null; // Limpa o alerta ativo
      
      // Notifica todos na sala que o alerta foi atendido
      io.to(code).emit('alert-acknowledged', { 
        by: socket.id,
        message: 'Ajuda a caminho!' 
      });
      console.log(`Alerta confirmado pelo cuidador ${socket.id} na sala: ${code}`);
    }
  });

  // 5. Desconexão
  socket.on('disconnect', () => {
    const code = socketToRoom.get(socket.id);
    const role = socketRole.get(socket.id);

    if (code) {
      const room = rooms.get(code);
      if (room) {
        if (role === 'elderly') {
          // Se o idoso desconectar, avisa os cuidadores e remove a sala
          console.log(`Idoso desconectou. Fechando sala: ${code}`);
          io.to(code).emit('elderly-disconnected');
          
          // Remove referências dos cuidadores conectando-os a nada
          room.caregivers.forEach(caregiverId => {
            socketToRoom.delete(caregiverId);
            socketRole.delete(caregiverId);
          });
          
          rooms.delete(code);
        } else if (role === 'caregiver') {
          // Se o cuidador desconectar, atualiza o status na sala
          room.caregivers.delete(socket.id);
          console.log(`Cuidador desconectou da sala: ${code}. Cuidadores restantes: ${room.caregivers.size}`);
          
          io.to(code).emit('caregiver-status', { 
            connected: room.caregivers.size > 0, 
            count: room.caregivers.size 
          });
        }
      }
      socketToRoom.delete(socket.id);
      socketRole.delete(socket.id);
    }
    console.log(`Dispositivo desconectado: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
