"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "@/context/AuthContext";
import {
  getMessages, sendMessage as apiSendMsg, updateMsgStatus,
  markRoomRead, reactToMessage, deleteMessage as apiDeleteMsg,
  getRoom, updateRoom,
} from "@/lib/api";
import {
  Send, Paperclip, MoreVertical, Phone, Video, ArrowLeft,
  Search, X, Pin, Download, Ban, Smile, Copy, Forward,
  Trash2, ChevronDown, Image as ImageIcon, Clock
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

const EMOJI_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "😡"];

const STICKER_PACKS = [
  ["😀","😂","🥰","😎","🤔","😴","🤯","🥳","😏","🤩"],
  ["👍","👎","👏","🙌","🤝","✌️","🤞","💪","🫶","🤜"],
  ["🔥","💯","✨","🎉","🎊","💥","⚡","🌟","🏆","🎯"],
  ["🐶","🐱","🐼","🦊","🐸","🦁","🐯","🦄","🐙","🦋"],
];

function extractUrls(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.match(urlRegex) || [];
}

function LinkCard({ url }) {
  const [meta, setMeta] = useState(null);
  useEffect(() => {
    try {
      const u = new URL(url);
      setMeta({ host: u.hostname, href: url });
    } catch {}
  }, [url]);
  if (!meta) return null;
  return (
    <a href={meta.href} target="_blank" rel="noopener noreferrer"
      className="block mt-2 p-2 bg-black/30 rounded-xl border border-white/10 hover:border-purple-500/50 transition-colors">
      <p className="text-[10px] text-zinc-500 truncate">🔗 {meta.host}</p>
      <p className="text-xs text-purple-300 truncate">{meta.href}</p>
    </a>
  );
}

export default function ChatWindow({ selectedChat, socket, onStartCall, onBack }) {
  const { user } = useAuth();

  const [messages,      setMessages]      = useState([]);
  const [newMessage,    setNewMessage]    = useState("");
  const [isTyping,      setIsTyping]      = useState(false);
  const [searchQuery,   setSearchQuery]   = useState("");
  const [showSearch,    setShowSearch]    = useState(false);
  const [showMenu,      setShowMenu]      = useState(false);
  const [showStickers,  setShowStickers]  = useState(false);
  const [pinnedMsg,     setPinnedMsg]     = useState(null);
  const [wallpaper,     setWallpaper]     = useState(null);
  const [reactionPicker,setReactionPicker]= useState(null);
  const [contextMenu,   setContextMenu]   = useState(null);
  const [isBlocked,     setIsBlocked]     = useState(false);
  const [disappearing,  setDisappearing]  = useState(false);
  const [stickerTab,    setStickerTab]    = useState(0);

  const scrollRef = useRef(null);
  const inputRef  = useRef(null);
  const menuRef   = useRef(null);
  const pollRef   = useRef(null);

  const roomId = user && selectedChat ? [user.uid, selectedChat.uid].sort().join("_") : null;

  // ── Close menus on outside click ────────────────────
  useEffect(() => {
    const handler = (e) => {
      if (!menuRef.current?.contains(e.target)) {
        setShowMenu(false);
        setContextMenu(null);
        setReactionPicker(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // ── Load messages + room metadata ───────────────────
  const loadMessages = useCallback(async () => {
    if (!roomId) return;
    try {
      const msgs = await getMessages(roomId);
      // Filter disappearing > 24h
      const now = Date.now();
      const filtered = msgs.filter(m => {
        if (m.disappearing && m.createdAt) {
          return (now - new Date(m.createdAt).getTime()) < 86400000;
        }
        return true;
      });
      setMessages(filtered);
      // Mark as read
      await markRoomRead(roomId, user.uid).catch(() => {});
    } catch (err) {
      console.error("loadMessages:", err);
    }
  }, [roomId, user?.uid]);

  const loadRoom = useCallback(async () => {
    if (!roomId) return;
    try {
      const room = await getRoom(roomId);
      setPinnedMsg(room.pinnedMsg || null);
      setWallpaper(room.wallpapers?.[user.uid] || null);
      setIsBlocked(room.blockedBy?.includes(user.uid) || false);
      setDisappearing(room.disappearing || false);
    } catch {}
  }, [roomId, user?.uid]);

  // Initial load
  useEffect(() => {
    loadMessages();
    loadRoom();
  }, [loadMessages, loadRoom]);

  // ── Polling for new messages (500ms) ────────────────
  useEffect(() => {
    if (!roomId) return;
    pollRef.current = setInterval(loadMessages, 1500);
    return () => clearInterval(pollRef.current);
  }, [loadMessages, roomId]);

  // Scroll to bottom on new messages
  useEffect(() => {
    setTimeout(() => scrollRef.current?.scrollIntoView({ behavior: "smooth" }), 80);
  }, [messages.length]);

  // ── Socket: typing + delivery + read receipts ───────
  useEffect(() => {
    if (!socket || !roomId) return;
    socket.emit("join-chat", roomId);

    // Tell the sender we read their messages (fires blue tick on their end)
    socket.emit("mark-read", {
      roomId,
      readerUid: user.uid,
      senderUid: selectedChat.uid,
    });

    const onTyping    = () => setIsTyping(true);
    const onStop      = () => setIsTyping(false);

    // Sender's ✓✓ turns grey when message delivered
    const onDelivered = async ({ messageId }) => {
      if (!messageId) return;
      try { await updateMsgStatus(messageId, "delivered"); } catch {}
      loadMessages();
    };

    // New message arrived — reload
    const onReceived = ({ senderId: msgSender }) => {
      loadMessages();
      // If the message is from the person we're chatting with, mark as read immediately
      if (msgSender === selectedChat.uid) {
        markRoomRead(roomId, user.uid).catch(() => {});
        socket.emit("mark-read", {
          roomId,
          readerUid: user.uid,
          senderUid: selectedChat.uid,
        });
      }
    };

    // Other user read OUR messages → reload so our ✓✓ turns blue
    const onMessagesRead = ({ roomId: r }) => {
      if (r === roomId) loadMessages();
    };

    socket.on("typing",           onTyping);
    socket.on("stop-typing",      onStop);
    socket.on("message-delivered",onDelivered);
    socket.on("message-received", onReceived);
    socket.on("messages-read",    onMessagesRead);
    return () => {
      socket.off("typing",           onTyping);
      socket.off("stop-typing",      onStop);
      socket.off("message-delivered",onDelivered);
      socket.off("message-received", onReceived);
      socket.off("messages-read",    onMessagesRead);
    };
  }, [socket, roomId, loadMessages, user?.uid, selectedChat?.uid]);

  // ── Send message ────────────────────────────────────
  const sendMessage = async (e, overrideText, isSticker = false) => {
    e?.preventDefault();
    const text = overrideText ?? newMessage;
    if (!text.trim() || isBlocked) return;
    if (!overrideText) setNewMessage("");
    socket?.emit("stop-typing", roomId);

    try {
      const msg = await apiSendMsg({
        roomId,
        senderId:     user.uid,
        text,
        isSticker:    isSticker || false,
        disappearing,
        status:       "sent",
      });
      socket?.emit("new-message", {
        roomId,
        senderId:  user.uid,
        receiverId: selectedChat.uid,
        messageId: msg._id,
      });
      loadMessages();
    } catch (err) {
      console.error("sendMessage:", err);
    }
  };

  const handleTyping = (e) => {
    setNewMessage(e.target.value);
    socket?.emit(e.target.value ? "typing" : "stop-typing", roomId);
  };

  // ── Reactions ───────────────────────────────────────
  const sendReaction = async (msgId, emoji) => {
    setReactionPicker(null);
    try {
      await reactToMessage(msgId, user.uid, emoji);
      loadMessages();
    } catch (err) {
      console.error("sendReaction:", err);
    }
  };

  // ── Pin ─────────────────────────────────────────────
  const pinMessage = async (msg) => {
    setContextMenu(null);
    const newPin = pinnedMsg?.id === msg._id ? null : { id: msg._id, text: msg.text };
    try {
      await updateRoom(roomId, { pinnedMsg: newPin });
      setPinnedMsg(newPin);
    } catch (err) { console.error("pinMessage:", err); }
  };

  const copyMessage = (text) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setContextMenu(null);
  };

  const deleteMsg = async (msgId) => {
    setContextMenu(null);
    try {
      await apiDeleteMsg(msgId);
      loadMessages();
    } catch (err) { console.error("deleteMessage:", err); }
  };

  const exportChat = () => {
    setShowMenu(false);
    const lines = messages.map(m => {
      const time   = m.createdAt ? new Date(m.createdAt).toLocaleString() : "unknown";
      const sender = m.senderId === user.uid ? "You" : selectedChat.name;
      return `[${time}] ${sender}: ${m.text}`;
    });
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const a    = document.createElement("a");
    a.href     = URL.createObjectURL(blob);
    a.download = `chat_${selectedChat.name}_${Date.now()}.txt`;
    a.click();
  };

  const toggleBlock = async () => {
    setShowMenu(false);
    const room     = await getRoom(roomId).catch(() => ({ blockedBy: [] }));
    const blockedBy = room.blockedBy || [];
    const newList  = isBlocked
      ? blockedBy.filter(u => u !== user.uid)
      : [...blockedBy, user.uid];
    try {
      await updateRoom(roomId, { blockedBy: newList });
      setIsBlocked(!isBlocked);
    } catch (err) { console.error("toggleBlock:", err); }
  };

  const toggleDisappearing = async () => {
    setShowMenu(false);
    try {
      await updateRoom(roomId, { disappearing: !disappearing });
      setDisappearing(d => !d);
    } catch (err) { console.error("toggleDisappearing:", err); }
  };

  const setWallpaperOption = async (color) => {
    setShowMenu(false);
    try {
      await updateRoom(roomId, { wallpaperUid: user.uid, wallpaperValue: color });
      setWallpaper(color);
    } catch (err) { console.error("setWallpaper:", err); }
  };

  const filteredMessages = searchQuery
    ? messages.filter(m => m.text?.toLowerCase().includes(searchQuery.toLowerCase()))
    : messages;

  const getStatusIcon = (msg) => {
    if (msg.senderId !== user.uid) return null;
    if (msg.status === "read")      return <span className="text-blue-400 text-[10px] font-semibold">Seen</span>;
    if (msg.status === "delivered") return <span className="text-zinc-400 text-[10px]">Delivered</span>;
    return <span className="text-zinc-500 text-[10px]">Sent</span>;
  };

  const handleLongPress = (e, msg) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    setContextMenu({ msgId: msg._id, msg, x: rect.left, y: rect.top });
  };

  const wallpapers = [
    { label: "Default", value: null },
    { label: "Purple",  value: "radial-gradient(ellipse at top, #3b1fa3 0%, #0c0c0e 70%)" },
    { label: "Ocean",   value: "radial-gradient(ellipse at top, #0c4a6e 0%, #0c0c0e 70%)" },
    { label: "Forest",  value: "radial-gradient(ellipse at top, #14532d 0%, #0c0c0e 70%)" },
    { label: "Sunset",  value: "radial-gradient(ellipse at top, #7c2d12 0%, #0c0c0e 70%)" },
  ];

  return (
    <div className="flex h-full flex-col bg-[#0c0c0e] relative" style={wallpaper ? { background: wallpaper } : {}}>

      {/* Header */}
      <header className="flex items-center justify-between border-b border-white/5 bg-black/60 backdrop-blur-md px-4 py-3 flex-shrink-0 z-10">
        <div className="flex items-center gap-3">
          {onBack && (
            <button onClick={onBack} className="md:hidden text-zinc-400 hover:text-white">
              <ArrowLeft size={20} />
            </button>
          )}
          <div className="relative flex-shrink-0">
            <img src={selectedChat.photoURL || `https://ui-avatars.com/api/?name=${selectedChat.name}&background=random`}
              alt="" className="h-8 w-8 md:h-9 md:w-9 rounded-full object-cover" />
            {selectedChat.status === "online" && (
              <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-black bg-green-500" />
            )}
          </div>
          <div>
            <h3 className="font-bold text-sm">{selectedChat.name}</h3>
            <p className="text-xs text-green-500">{isTyping ? "typing..." : selectedChat.status === "online" ? "Online" : "Offline"}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 md:gap-3 text-zinc-400">
          {disappearing && <Clock size={14} className="text-yellow-500 hidden sm:block" title="Disappearing messages on" />}
          <button onClick={() => setShowSearch(s => !s)} className="p-1 hover:text-white transition-colors"><Search size={18} /></button>
          <button onClick={() => onStartCall?.("audio")} className="p-1 hover:text-white transition-colors"><Phone size={18} /></button>
          <button onClick={() => onStartCall?.("video")} className="p-1 hover:text-white transition-colors"><Video size={18} /></button>
          <div className="relative" ref={menuRef}>
            <button onClick={() => setShowMenu(s => !s)} className="hover:text-white transition-colors"><MoreVertical size={18} /></button>
            <AnimatePresence>
              {showMenu && (
                <motion.div initial={{ opacity: 0, scale: 0.9, y: -8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9 }}
                  className="absolute right-0 top-8 z-50 w-52 bg-[#1a1a1e] border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
                  <MenuItem icon={<Download size={14} />} label="Export Chat" onClick={exportChat} />
                  <MenuItem icon={<Clock size={14} />} label={disappearing ? "Turn Off Disappearing" : "Disappearing Messages"} onClick={toggleDisappearing} />
                  <div className="border-t border-white/5" />
                  <p className="text-[10px] text-zinc-500 px-4 pt-3 pb-1 uppercase tracking-widest">Wallpaper</p>
                  <div className="flex gap-2 px-4 pb-3 flex-wrap">
                    {wallpapers.map(w => (
                      <button key={w.label} onClick={() => setWallpaperOption(w.value)} title={w.label}
                        className={`h-6 w-6 rounded-full border-2 transition-all ${wallpaper === w.value ? "border-purple-500 scale-110" : "border-white/10"}`}
                        style={w.value ? { background: w.value } : { background: "#1a1a1e" }}>
                        {!w.value && <span className="text-[8px] flex items-center justify-center h-full text-zinc-400">✕</span>}
                      </button>
                    ))}
                  </div>
                  <div className="border-t border-white/5" />
                  <MenuItem icon={<Ban size={14} />} label={isBlocked ? "Unblock User" : "Block User"} onClick={toggleBlock} danger={!isBlocked} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </header>

      {/* Search Bar */}
      <AnimatePresence>
        {showSearch && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="bg-black/40 backdrop-blur-md border-b border-white/5 px-4 py-2 flex items-center gap-2 overflow-hidden flex-shrink-0">
            <Search size={14} className="text-zinc-500" />
            <input autoFocus value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search messages..." className="flex-1 bg-transparent text-sm outline-none placeholder:text-zinc-600 text-white" />
            <button onClick={() => { setShowSearch(false); setSearchQuery(""); }} className="text-zinc-500 hover:text-white"><X size={14} /></button>
            {searchQuery && <span className="text-[10px] text-zinc-500">{filteredMessages.length} found</span>}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Pinned Message */}
      <AnimatePresence>
        {pinnedMsg && (
          <motion.div initial={{ y: -20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -20, opacity: 0 }}
            className="flex items-center gap-2 px-4 py-2 bg-purple-900/20 border-b border-purple-500/20 flex-shrink-0">
            <Pin size={12} className="text-purple-400 flex-shrink-0" />
            <p className="text-xs text-purple-300 truncate flex-1">{pinnedMsg.text}</p>
            <button onClick={() => updateRoom(roomId, { pinnedMsg: null }).then(() => setPinnedMsg(null)).catch(() => {})}
              className="text-zinc-500 hover:text-white"><X size={12} /></button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Messages */}
      <main className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
        {filteredMessages.map((msg, i) => {
          if (msg.isSystem) return (
            <div key={msg._id || i} className="flex justify-center my-1">
              <div className="bg-white/5 border border-white/10 px-4 py-1 rounded-full text-[10px] text-zinc-400">{msg.text}</div>
            </div>
          );
          const isMe = msg.senderId === user.uid;
          const urls = extractUrls(msg.text || "");
          const reactions = msg.reactions || {};
          const reactionCounts = Object.values(reactions).reduce((acc, e) => {
            acc[e] = (acc[e] || 0) + 1; return acc;
          }, {});
          return (
            <motion.div key={msg._id || i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              className={`flex ${isMe ? "justify-end" : "justify-start"} group`}>
              <div className="relative max-w-[80%] md:max-w-[65%]">
                <button
                  onClick={() => setReactionPicker(reactionPicker === msg._id ? null : msg._id)}
                  onContextMenu={e => handleLongPress(e, msg)}
                  className={`absolute ${isMe ? "-left-7" : "-right-7"} top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity z-10`}>
                  <Smile size={14} className="text-zinc-500 hover:text-yellow-400" />
                </button>

                <div onContextMenu={e => handleLongPress(e, msg)}
                  className={`rounded-2xl px-4 py-2.5 cursor-pointer ${
                    msg.isSticker ? "bg-transparent text-4xl px-2"
                    : isMe ? "bg-purple-600 text-white rounded-tr-none"
                    : "bg-white/8 text-zinc-200 rounded-tl-none border border-white/5"
                  }`}>
                  {!msg.isSticker && <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.text}</p>}
                  {msg.isSticker  && <span className="text-4xl">{msg.text}</span>}
                  {urls.length > 0 && !msg.isSticker && urls.map((u, idx) => <LinkCard key={idx} url={u} />)}
                  <div className={`flex items-center gap-1 mt-1 ${isMe ? "justify-end" : "justify-start"}`}>
                    <p className={`text-[10px] ${isMe ? "text-purple-200" : "text-zinc-500"}`}>
                      {msg.createdAt ? new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "now"}
                    </p>
                    {isMe && <span className="ml-1">{getStatusIcon(msg)}</span>}
                  </div>
                </div>

                {Object.keys(reactionCounts).length > 0 && (
                  <div className={`flex gap-1 mt-1 flex-wrap ${isMe ? "justify-end" : "justify-start"}`}>
                    {Object.entries(reactionCounts).map(([emoji, count]) => (
                      <button key={emoji} onClick={() => sendReaction(msg._id, emoji)}
                        className="flex items-center gap-0.5 bg-white/10 hover:bg-white/20 rounded-full px-1.5 py-0.5 text-[11px] border border-white/10 transition-colors">
                        {emoji}<span className="text-zinc-400 text-[10px]">{count}</span>
                      </button>
                    ))}
                  </div>
                )}

                <AnimatePresence>
                  {reactionPicker === msg._id && (
                    <motion.div initial={{ opacity: 0, scale: 0.8, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.8 }}
                      className={`absolute ${isMe ? "right-0" : "left-0"} -top-12 z-20 flex gap-1 bg-[#1a1a1e] border border-white/10 rounded-2xl p-2 shadow-xl`}>
                      {EMOJI_REACTIONS.map(emoji => (
                        <button key={emoji} onClick={() => sendReaction(msg._id, emoji)} className="text-xl hover:scale-125 transition-transform p-0.5">{emoji}</button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          );
        })}
        <div ref={scrollRef} />
      </main>

      {/* Context Menu */}
      <AnimatePresence>
        {contextMenu && (
          <motion.div ref={menuRef} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}
            style={{ top: Math.min(contextMenu.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 200), left: Math.min(contextMenu.x, (typeof window !== 'undefined' ? window.innerWidth : 600) - 180) }}
            className="fixed z-50 w-44 bg-[#1a1a1e] border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
            <MenuItem icon={<Copy size={13} />} label="Copy" onClick={() => copyMessage(contextMenu.msg.text)} />
            <MenuItem icon={<Pin size={13} />} label="Pin Message" onClick={() => { pinMessage(contextMenu.msg); setContextMenu(null); }} />
            <MenuItem icon={<Smile size={13} />} label="React" onClick={() => { setReactionPicker(contextMenu.msgId); setContextMenu(null); }} />
            {contextMenu.msg.senderId === user.uid && (
              <MenuItem icon={<Trash2 size={13} />} label="Delete" danger onClick={() => deleteMsg(contextMenu.msgId)} />
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Blocked Banner */}
      {isBlocked && (
        <div className="flex-shrink-0 bg-red-900/20 border-t border-red-500/20 px-4 py-3 text-center">
          <p className="text-xs text-red-400">You have blocked this user. <button onClick={toggleBlock} className="underline">Unblock</button></p>
        </div>
      )}

      {/* Sticker Picker */}
      <AnimatePresence>
        {showStickers && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="flex-shrink-0 bg-[#141416] border-t border-white/5 overflow-hidden">
            <div className="flex border-b border-white/5">
              {STICKER_PACKS.map((_, idx) => (
                <button key={idx} onClick={() => setStickerTab(idx)}
                  className={`flex-1 py-2 text-xs transition-colors ${stickerTab === idx ? "text-purple-400 border-b-2 border-purple-500" : "text-zinc-500"}`}>
                  {["😀", "👍", "🔥", "🐶"][idx]}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-10 gap-1 p-3 max-h-28 overflow-y-auto">
              {STICKER_PACKS[stickerTab].map((s, i) => (
                <button key={i} onClick={() => { sendMessage(null, s, true); setShowStickers(false); }}
                  className="text-2xl hover:scale-125 transition-transform p-1">{s}</button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Input */}
      {!isBlocked && (
        <footer className="bg-black/60 backdrop-blur-md p-2 md:p-3 flex-shrink-0 border-t border-white/5 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] md:pb-3">
          <form onSubmit={sendMessage} className="flex items-center gap-2 rounded-2xl bg-white/5 p-1.5 md:p-2 pr-3 focus-within:ring-1 focus-within:ring-purple-500/50">
            <button type="button" onClick={() => setShowStickers(s => !s)}
              className={`p-1.5 md:p-2 transition-colors ${showStickers ? "text-yellow-400" : "text-zinc-500 hover:text-white"}`}>
              <Smile size={20} />
            </button>
            <input ref={inputRef} type="text" placeholder="Type a message..."
              value={newMessage} onChange={handleTyping}
              className="flex-1 bg-transparent py-2 px-1 text-sm outline-none placeholder:text-zinc-600 text-white min-w-0" />
            <button type="submit" disabled={!newMessage.trim()}
              className="flex h-8 w-8 md:h-9 md:w-9 items-center justify-center rounded-xl bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-40 transition-all flex-shrink-0">
              <Send size={16} />
            </button>
          </form>
        </footer>
      )}
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger }) {
  return (
    <button onClick={onClick}
      className={`flex w-full items-center gap-3 px-4 py-2.5 text-sm hover:bg-white/5 transition-colors text-left ${danger ? "text-red-400" : "text-zinc-300"}`}>
      {icon}{label}
    </button>
  );
}
