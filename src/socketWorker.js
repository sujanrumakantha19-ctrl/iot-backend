const { parentPort } = require('worker_threads')
const http = require('http')
const socketIO = require('socket.io')

const PORT = 4000

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('Socket.IO Worker is running!')
})

const io = socketIO(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
})

io.on('connection', (socket) => {
  console.log('[Socket Worker] Client connected:', socket.id)

  socket.on('join', (data) => {
    if (!data) return
    const { role, companyId, employeeId } = data
    
    if (role === 'admin') {
      socket.join('admins')
      console.log(`[Socket Worker] ${socket.id} joined admins room`)
    } else if (role === 'manager' && companyId) {
      socket.join(`company:${companyId}`)
      console.log(`[Socket Worker] ${socket.id} joined company:${companyId} room`)
    } else if (role === 'employee' && employeeId) {
      socket.join(`employee:${employeeId}`)
      console.log(`[Socket Worker] ${socket.id} joined employee:${employeeId} room`)
    }
  })

  socket.on('disconnect', () => {
    console.log('[Socket Worker] Client disconnected:', socket.id)
  })
})

// Listen for messages from main thread
parentPort.on('message', (msg) => {
  if (msg.type === 'emit') {
    const { room, event, data } = msg
    if (room) {
      io.to(room).emit(event, data)
    } else {
      io.emit(event, data)
    }
  }
})

server.listen(PORT, () => {
  console.log(`[Socket Worker] Socket.IO server running on http://localhost:${PORT}`)
})
