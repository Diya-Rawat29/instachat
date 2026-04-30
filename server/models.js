const mongoose = require('mongoose');

// ── User ──────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  uid:         { type: String, required: true, unique: true }, // Firebase UID
  name:        { type: String, default: 'New User' },
  email:       { type: String },
  photoURL:    { type: String },
  username:    { type: String, lowercase: true, trim: true },
  bio:         { type: String, default: '' },
  phone:       { type: String, default: '' },
  dob:         { type: String, default: '' },
  status:      { type: String, default: 'offline' }, // online | offline
  connections: [{ type: String }],                   // array of Firebase UIDs
  isProfileComplete: { type: Boolean, default: false },
  lastSeen:    { type: Date, default: Date.now },
}, { timestamps: true });

// ── Request ───────────────────────────────────────────
const requestSchema = new mongoose.Schema({
  senderId:       { type: String, required: true },
  senderName:     { type: String },
  senderPhoto:    { type: String },
  senderUsername: { type: String },
  receiverId:     { type: String, required: true },
  status:         { type: String, default: 'pending' }, // pending | accepted | rejected
}, { timestamps: true });

// ── Message ───────────────────────────────────────────
const messageSchema = new mongoose.Schema({
  roomId:       { type: String, required: true, index: true },
  senderId:     { type: String, required: true },
  text:         { type: String, default: '' },
  status:       { type: String, default: 'sent' }, // sent | delivered | read
  isSticker:    { type: Boolean, default: false },
  isSystem:     { type: Boolean, default: false },
  disappearing: { type: Boolean, default: false },
  reactions:    { type: Map, of: String, default: {} },
}, { timestamps: true });

// ── Room ──────────────────────────────────────────────
const roomSchema = new mongoose.Schema({
  roomId:      { type: String, required: true, unique: true },
  pinnedMsg:   { type: Object, default: null },  // { id, text }
  disappearing:{ type: Boolean, default: false },
  blockedBy:   [{ type: String }],
  wallpapers:  { type: Map, of: String, default: {} }, // uid -> gradient string
}, { timestamps: true });

module.exports = {
  User:    mongoose.model('User',    userSchema),
  Request: mongoose.model('Request', requestSchema),
  Message: mongoose.model('Message', messageSchema),
  Room:    mongoose.model('Room',    roomSchema),
};
