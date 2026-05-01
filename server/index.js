const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const mongoose   = require('mongoose');
require('dotenv').config();

const { User, Request, Message, Room } = require('./models');

const ALLOWED_ORIGINS = [
  'https://instachat-nu.vercel.app',
  'http://localhost:3000',
  'http://localhost:3001',
  ...(process.env.ALLOWED_ORIGIN && process.env.ALLOWED_ORIGIN !== '*'
    ? [process.env.ALLOWED_ORIGIN]
    : []),
];
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/instachat';

// ── Express setup ─────────────────────────────────────
const app = express();
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (Postman, mobile apps, server-to-server)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.vercel.app')) return callback(null, true);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Handle preflight for all routes
app.use(express.json());

// ── MongoDB connect ───────────────────────────────────
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Error:', err));

// ── Health check ──────────────────────────────────────
app.get('/', (req, res) => res.send('InstaChat Server ✅ (MongoDB)'));

// ══════════════════════════════════════════════════════
//  USER ROUTES
// ══════════════════════════════════════════════════════

// Create / upsert user (called right after Firebase login)
app.post('/api/users', async (req, res) => {
  try {
    const { uid, name, email, photoURL } = req.body;
    if (!uid) return res.status(400).json({ error: 'uid required' });
    
    let user;
    try {
      user = await User.findOneAndUpdate(
        { uid },
        { $setOnInsert: { uid, name, email, photoURL } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } catch (upsertErr) {
      if (upsertErr.code === 11000 && email) {
        // If duplicate key error (e.g. email exists with different uid)
        // Update the existing document with the new uid
        user = await User.findOneAndUpdate(
          { email },
          { $set: { uid, name, photoURL } },
          { new: true }
        );
        if (!user) throw upsertErr;
      } else {
        throw upsertErr;
      }
    }
    
    res.json(user);
  } catch (err) {
    console.error("Error in /api/users:", err);
    res.status(500).json({ error: err.message });
  }
});

// ⚠️ All SPECIFIC routes must come BEFORE the generic /:uid route

// Search users by email OR username (excludes self)
app.get('/api/users/search/:term', async (req, res) => {
  try {
    const { term } = req.params;
    const { selfUid } = req.query;
    const users = await User.find({
      uid: { $ne: selfUid },
      $or: [
        { email:    { $regex: `^${term}$`, $options: 'i' } },
        { username: { $regex: `^${term}$`, $options: 'i' } },
      ]
    }).limit(20).select('-__v');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check if username is taken
app.get('/api/users/username/:username', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.params.username.toLowerCase() });
    res.json({ taken: !!user, uid: user?.uid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get multiple users by uid list (for connections sidebar)
app.post('/api/users/batch', async (req, res) => {
  try {
    const { uids } = req.body;
    if (!uids || !uids.length) return res.json([]);
    const users = await User.find({ uid: { $in: uids } }).select('-__v');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get recommended users (mutual connections + random)
app.get('/api/users/recommendations/:uid', async (req, res) => {
  try {
    const uid = req.params.uid;
    const currentUser = await User.findOne({ uid });
    if (!currentUser) return res.status(404).json({ error: 'User not found' });

    const currentConns = currentUser.connections || [];
    const excludeUids = [...currentConns, uid];
    
    // 1. Try to find users who share connections (Mutual Friends)
    let recommendations = await User.aggregate([
      { $match: { uid: { $nin: excludeUids } } },
      { $addFields: { 
          mutualCount: { 
            $size: { $setIntersection: [ { $ifNull: ["$connections", []] }, currentConns ] } 
          }
      }},
      { $match: { mutualCount: { $gt: 0 } } },
      { $sort: { mutualCount: -1 } },
      { $limit: 5 }
    ]);
    
    // 2. Pad with random users if needed
    if (recommendations.length < 5) {
      const needed = 5 - recommendations.length;
      const recUids = recommendations.map(r => r.uid);
      const randomUsers = await User.aggregate([
        { $match: { uid: { $nin: [...excludeUids, ...recUids] } } },
        { $sample: { size: needed } },
        { $addFields: { mutualCount: 0 } }
      ]);
      recommendations = [...recommendations, ...randomUsers];
    }
    
    res.json(recommendations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Generic /:uid catch-all — MUST come after all specific /users/* routes
// Get current user profile
app.get('/api/users/:uid', async (req, res) => {
  try {
    const user = await User.findOne({ uid: req.params.uid });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update profile
app.patch('/api/users/:uid', async (req, res) => {
  try {
    const allowed = ['name', 'username', 'bio', 'phone', 'dob', 'photoURL', 'isProfileComplete', 'status', 'lastSeen'];
    const update  = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    const user = await User.findOneAndUpdate({ uid: req.params.uid }, update, { new: true });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  FRIEND REQUEST ROUTES
// ══════════════════════════════════════════════════════

// Get pending requests for a user
app.get('/api/requests/:uid', async (req, res) => {
  try {
    const requests = await Request.find({ receiverId: req.params.uid, status: 'pending' });
    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send a friend request
app.post('/api/requests', async (req, res) => {
  try {
    const { senderId, senderName, senderPhoto, senderUsername, receiverId } = req.body;
    // Prevent duplicate requests
    const existing = await Request.findOne({ senderId, receiverId, status: 'pending' });
    if (existing) return res.json(existing);
    const request = await Request.create({ senderId, senderName, senderPhoto, senderUsername, receiverId });
    res.json(request);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accept a request
app.patch('/api/requests/:id/accept', async (req, res) => {
  try {
    const request = await Request.findByIdAndUpdate(req.params.id, { status: 'accepted' }, { new: true });
    if (!request) return res.status(404).json({ error: 'Request not found' });

    // Add each user to the other's connections
    await User.updateOne({ uid: request.receiverId }, { $addToSet: { connections: request.senderId } });
    await User.updateOne({ uid: request.senderId  }, { $addToSet: { connections: request.receiverId } });

    res.json(request);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  MESSAGE ROUTES
// ══════════════════════════════════════════════════════

// Get messages for a room
app.get('/api/messages/:roomId', async (req, res) => {
  try {
    const msgs = await Message.find({ roomId: req.params.roomId }).sort({ createdAt: 1 }).limit(200);
    res.json(msgs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send a message
app.post('/api/messages', async (req, res) => {
  try {
    const { roomId, senderId, text, isSticker, isSystem, disappearing } = req.body;
    const msg = await Message.create({ roomId, senderId, text, isSticker, isSystem, disappearing });
    res.json(msg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update message status (delivered / read)
app.patch('/api/messages/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const msg = await Message.findByIdAndUpdate(req.params.id, { status }, { new: true });
    res.json(msg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark all messages in a room as read
// ⚠️ Uses distinct path /read-room/:roomId to avoid conflict with /:id/status
app.patch('/api/messages/read-room/:roomId', async (req, res) => {
  try {
    const { readerUid } = req.body;
    await Message.updateMany(
      { roomId: req.params.roomId, senderId: { $ne: readerUid }, status: { $ne: 'read' } },
      { status: 'read' }
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// React to a message
app.patch('/api/messages/:id/react', async (req, res) => {
  try {
    const { uid, emoji } = req.body;
    const msg = await Message.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Not found' });
    if (msg.reactions.get(uid) === emoji) {
      msg.reactions.delete(uid);
    } else {
      msg.reactions.set(uid, emoji);
    }
    await msg.save();
    res.json(msg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a message
app.delete('/api/messages/:id', async (req, res) => {
  try {
    await Message.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unread count for a room (messages NOT sent by me, not read)
// ⚠️ Must come before /:id routes — uses full roomId string so won't conflict
app.get('/api/messages/unread/:roomId/:uid', async (req, res) => {
  try {
    const count = await Message.countDocuments({
      roomId: req.params.roomId,
      senderId: { $ne: req.params.uid },
      status: { $ne: 'read' }
    });
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  ROOM ROUTES
// ══════════════════════════════════════════════════════

// Get room metadata
app.get('/api/rooms/:roomId', async (req, res) => {
  try {
    let room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) room = { roomId: req.params.roomId, pinnedMsg: null, disappearing: false, blockedBy: [], wallpapers: {} };
    res.json(room);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upsert room metadata
app.patch('/api/rooms/:roomId', async (req, res) => {
  try {
    const allowed = ['pinnedMsg', 'disappearing', 'blockedBy'];
    const update  = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });

    // Handle wallpaper per user
    if (req.body.wallpaperUid && req.body.wallpaperValue !== undefined) {
      update[`wallpapers.${req.body.wallpaperUid}`] = req.body.wallpaperValue;
    }

    const room = await Room.findOneAndUpdate(
      { roomId: req.params.roomId },
      update,
      { upsert: true, new: true }
    );
    res.json(room);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  SOCKET.IO  (real-time relay — no data stored here)
// ══════════════════════════════════════════════════════
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] }
});

let onlineUsers = new Map(); // uid → socketId

io.on('connection', (socket) => {
  console.log('User Connected:', socket.id);

  socket.on('setup', async (userData) => {
    socket.join(userData.uid);
    onlineUsers.set(userData.uid, socket.id);
    socket.emit('connected');
    io.emit('user-online', userData.uid);
    // Update status in MongoDB
    await User.updateOne({ uid: userData.uid }, { status: 'online', lastSeen: new Date() }).catch(() => {});
  });

  socket.on('join-chat', (room) => {
    socket.join(room);
    console.log('User Joined Room:', room);
  });

  socket.on('typing',      (room) => socket.in(room).emit('typing'));
  socket.on('stop-typing', (room) => socket.in(room).emit('stop-typing'));

  socket.on('new-message', (payload) => {
    const { roomId, senderId, receiverId, messageId } = payload;
    if (!roomId) return;
    socket.in(roomId).emit('message-received', payload);

    // Tell sender their message was delivered (receiver is online)
    if (receiverId && messageId && onlineUsers.has(receiverId)) {
      const senderSocketId = onlineUsers.get(senderId);
      if (senderSocketId) io.to(senderSocketId).emit('message-delivered', { messageId });
    }
  });

  // Receiver opened the chat — mark messages as read and notify original sender
  socket.on('mark-read', ({ roomId, readerUid, senderUid }) => {
    const senderSocketId = onlineUsers.get(senderUid);
    if (senderSocketId) {
      io.to(senderSocketId).emit('messages-read', { roomId, readerUid });
    }
  });

  // ── WebRTC Signaling (use io.to() not socket.in() for reliable delivery) ──
  socket.on('call-user', (data) => {
    io.to(data.userToCall).emit('incoming-call', {
      signal: data.signal,
      from: data.from,
      name: data.name,
      callType: data.callType,
    });
  });

  socket.on('answer-call', (data) => {
    io.to(data.to).emit('call-accepted', { signal: data.signal });
  });

  socket.on('ice-candidate', (data) => {
    io.to(data.to).emit('ice-candidate', { candidate: data.candidate });
  });

  socket.on('call-ended',    (data) => io.to(data.to).emit('call-ended'));
  socket.on('call-rejected', (data) => io.to(data.to).emit('call-rejected'));
  socket.on('call-busy',     (data) => io.to(data.to).emit('call-busy'));

  socket.on('disconnect', async () => {
    console.log('User Disconnected:', socket.id);
    let disconnectedUid = null;
    onlineUsers.forEach((sid, uid) => { if (sid === socket.id) disconnectedUid = uid; });
    if (disconnectedUid) {
      onlineUsers.delete(disconnectedUid);
      io.emit('user-offline', disconnectedUid);
      await User.updateOne({ uid: disconnectedUid }, { status: 'offline', lastSeen: new Date() }).catch(() => {});
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));
