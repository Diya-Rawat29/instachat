"use client";

import { useAuth } from "@/context/AuthContext";
import { useRouter } from "next/navigation";
import { useEffect, useState, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MessageSquare, Phone, Users, Settings, Search, LogOut, Plus, Bell, Mic, MicOff, Video, VideoOff, PhoneOff, MonitorUp, Wifi } from "lucide-react";
import SearchModal from "@/components/SearchModal";
import ChatWindow from "@/components/ChatWindow";
import CompleteProfileModal from "@/components/CompleteProfileModal";
import SettingsPanel from "@/components/SettingsPanel";
import { getRequests, acceptRequest as apiAcceptRequest, batchUsers, getUnreadCount, sendMessage as apiSendMsg, getUser, subscribeToPush } from "@/lib/api";
import { messaging, getToken, onMessage } from "@/lib/firebase";
import { io } from "socket.io-client";

const SOCKET_SERVER = process.env.NEXT_PUBLIC_SOCKET_SERVER_URL || "http://localhost:5000";
const VAPID_PUBLIC_KEY = "BP3OnY6Jhot7hFpvRfkUuCmkLmc_7TQD6Mi3gT-k8HZN_WqbH2R221tlP3qsCRQLqLimrFVrbHdvR1nlU67cAMg";

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

const ICE_SERVERS = {
  iceServers: [
    // Google STUN pool
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    // Cloudflare STUN (very reliable)
    { urls: "stun:stun.cloudflare.com:3478" },
    // ExpressTURN — free, reliable 24/7 public TURN
    {
      urls: "turn:relay1.expressturn.com:3478",
      username: "efVQFDZCRD2XZWDWC2",
      credential: "u3IlkTJPWmNHFX9Z",
    },
    // OpenRelay as secondary fallback
    { urls: "turn:openrelay.metered.ca:80",              username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443",             username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443?transport=tcp",username: "openrelayproject", credential: "openrelayproject" },
  ],
  iceCandidatePoolSize: 10,
  iceTransportPolicy: "all",  // try direct (STUN) first, TURN as fallback
};

export default function Dashboard() {
  const { user, profileData, loading, logout } = useAuth();
  const router = useRouter();

  // UI state
  const [activeTab, setActiveTab] = useState("chats");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [incomingRequests, setIncomingRequests] = useState([]);
  const [connections, setConnections] = useState([]);
  const [selectedChat, setSelectedChat] = useState(null);
  const [unreadCounts, setUnreadCounts] = useState({}); // uid -> count
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [toast, setToast] = useState(null); // { name, text, photo, uid }
  const toastTimerRef = useRef(null);
  const selectedChatRef = useRef(null); // stable ref for socket closure

  // Socket — tracked in state so children re-render on reconnect
  const [socket, setSocket] = useState(null);

  // Call state
  const [socketConnected, setSocketConnected] = useState(false);
  const [callState, setCallState] = useState(null); // null | "calling" | "incoming" | "connected"
  const [callerName, setCallerName] = useState("");
  const [isAudioOnly, setIsAudioOnly] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [callTarget, setCallTarget] = useState(null); // who we're calling / who called us

  // WebRTC refs
  const socketRef = useRef(null);            // stable ref for closures (WebRTC)
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const pendingIceCandidates = useRef([]);   // ICE only (not offer)
  const pendingOfferSdp = useRef(null);      // stored offer SDP from caller
  const isInitiator = useRef(false);
  const callFromRef = useRef(null);
  const callTypeRef = useRef("video");
  const callStateRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const cleanupCallRef = useRef(null);       // stable ref to avoid stale closures
  const callTimeoutRef = useRef(null);       // auto-cancel if no answer in 30s
  const iceRestartCount = useRef(0);         // limit ICE restart attempts

  // Audio refs
  const ringtoneRef = useRef(null);
  const ringingRef = useRef(null);
  const notificationRef = useRef(null);

  useEffect(() => { callStateRef.current = callState; }, [callState]);

  // keep selectedChatRef in sync for socket closures
  useEffect(() => { selectedChatRef.current = selectedChat; }, [selectedChat]);

  // ── FCM Notification Setup ──
  useEffect(() => {
    if (!user || typeof window === "undefined") return;

    const setupNotifications = async () => {
      try {
        // 1. Request permission
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          console.warn("🔔 Notification permission denied");
          return;
        }

        // 2. Get FCM Token
        if (messaging) {
          const token = await getToken(messaging, { vapidKey: VAPID_PUBLIC_KEY });
          if (token) {
            console.log("✅ FCM Token:", token);
            // Alert for debugging on phone
            if (process.env.NODE_ENV === 'production' || true) { // temporary true for debugging
               alert("Notifications Setup Successful! ✅");
            }
            // We'll wrap the token in the same structure our backend expects
            const subscription = { fcmToken: token, type: 'fcm' };
            await subscribeToPush(user.uid, subscription).catch(e => console.error("Push subscribe error:", e));
          }
        }

        // 3. Listen for foreground messages
        onMessage(messaging, (payload) => {
          console.log("📨 Foreground Message Received:", payload);
          // In-app notifications are already handled by Socket.io, 
          // but we can add more logic here if needed.
        });

      } catch (err) {
        console.error("❌ Notification setup failed:", err);
      }
    };

    setupNotifications();
  }, [user]);

  // ── Redirect if logged out ──
  useEffect(() => {
    if (!loading && !user) router.push("/");
  }, [user, loading, router]);

  // ── Socket setup (at Dashboard level — works everywhere) ──
  useEffect(() => {
    if (!user) return;
    const sock = io(SOCKET_SERVER, {
      transports: ["websocket", "polling"],
      reconnectionAttempts: 15,
      reconnectionDelay: 2000,
      autoConnect: false,   // prevent race with Fast Refresh
    });
    socketRef.current = sock;

    // ── Unlock Audio on first click ──
    const unlockAudio = () => {
      if (notificationRef.current) {
        notificationRef.current.volume = 0;
        notificationRef.current.play().then(() => {
          notificationRef.current.pause();
          notificationRef.current.volume = 1;
        }).catch(() => {});
      }
      window.removeEventListener("click", unlockAudio);
    };
    window.addEventListener("click", unlockAudio);

    // Delay initial connect to give backend time to start up when run via ru.bat
    // This prevents the scary red 'WebSocket closed' error in the console.
    // Connect immediately
    sock.connect();
    setSocket(sock);

    const doSetup = () => {
      sock.emit("setup", { uid: user.uid, displayName: user.displayName });
      setSocket(sock);      // re-expose after reconnect
      setSocketConnected(true);
    };
    sock.on("connect", () => {
      console.log("✅ Socket Connected:", sock.id);
      doSetup();
    });
    sock.on("reconnect", () => {
      console.log("🔄 Socket Reconnected");
      doSetup();
    });
    sock.on("disconnect", (reason) => {
      console.warn("❌ Socket Disconnected:", reason);
      setSocketConnected(false);
    });
    sock.on("connect_error", (err) => {
      console.error("⚠️ Socket Connection Error:", err.message);
      setSocketConnected(false);
    });

    sock.on("incoming-call", ({ signal, from, name, callType }) => {
      if (callStateRef.current) return; // already in a call
      callFromRef.current = from;
      callTypeRef.current = callType || "video";
      setCallerName(name);
      setIsAudioOnly(callType === "audio");
      setCallTarget({ uid: from, name });
      setCallState("incoming");
      // Store the offer SDP separately so ICE candidates don't mix with it
      if (signal?.type === "offer") {
        pendingOfferSdp.current = signal.sdp;
      }
    });

    sock.on("call-accepted", async ({ signal }) => {
      if (!pcRef.current || signal?.type !== "answer") return;
      try {
        await pcRef.current.setRemoteDescription(
          new RTCSessionDescription({ type: "answer", sdp: signal.sdp })
        );
        // Flush any ICE candidates that arrived before remote description was set
        for (const c of pendingIceCandidates.current) {
          await pcRef.current.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
        }
        pendingIceCandidates.current = [];
        // Don't setCallState("connected") here — wait for onconnectionstatechange
      } catch (err) { console.error("[WebRTC] setRemoteDescription(answer) failed:", err); }
    });

    sock.on("ice-candidate", async ({ candidate }) => {
      if (!candidate) return;
      if (pcRef.current?.remoteDescription?.type) {
        // Remote description already set — add immediately
        await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate)).catch((e) =>
          console.warn("[ICE] addIceCandidate failed:", e)
        );
      } else {
        // Queue until setRemoteDescription is called
        pendingIceCandidates.current.push(candidate);
      }
    });

    sock.on("call-ended",   () => cleanupCallRef.current?.());
    sock.on("call-rejected", () => {
      cleanupCallRef.current?.();
    });
    sock.on("call-busy", () => {
      cleanupCallRef.current?.();
    });

    // ── In-app + browser notifications ──────────────────
    sock.on("message-received", (payload) => {
      const { senderId, text, isSticker } = payload;
      console.log("📩 Message Received:", payload);

      // Play notification sound
      if (notificationRef.current) {
        notificationRef.current.currentTime = 0;
        notificationRef.current.play().catch(err => console.warn("🔈 Sound play failed:", err));
      }

      // Only notify if the sender is NOT the current open chat
      if (selectedChatRef.current?.uid === senderId) {
        console.log("ℹ️ Skipping notification: Chat is currently open");
        return;
      }

      // Find sender info from connections
      setConnections(prev => {
        const sender = prev.find(c => c.uid === senderId);
        if (!sender) return prev;

        // Bump unread count
        setUnreadCounts(counts => ({ ...counts, [senderId]: (counts[senderId] || 0) + 1 }));

        const displayMsg = isSticker ? "Sent a sticker" : text || "Sent a message";

        // In-app toast
        clearTimeout(toastTimerRef.current);
        setToast({ name: sender.name, text: displayMsg, photo: sender.photoURL, uid: senderId, chat: sender });
        toastTimerRef.current = setTimeout(() => setToast(null), 4000);

        // Browser / OS notification
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          // Only show OS notification if tab is hidden OR if tab is visible but we're not in that chat
          const shouldNotify = document.visibilityState === 'hidden' || selectedChatRef.current?.uid !== senderId;
          
          if (shouldNotify) {
            // Haptic feedback
            if ('vibrate' in navigator) navigator.vibrate([100, 50, 100]);

            const n = new Notification(sender.name, {
              body: displayMsg,
              icon: sender.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(sender.name)}&background=7c3aed&color=fff`,
              tag: senderId, // collapses duplicate notifications
            });
            n.onclick = () => { window.focus(); n.close(); };
          }
        }
        return prev;
      });
    });

    return () => { sock.disconnect(); setSocket(null); };
  }, [user]); // eslint-disable-line

  // ── Poll MongoDB for requests, connections, unread counts ──
  const fetchDashboardData = useCallback(async () => {
    if (!user) return;
    try {
      // 1. Pending friend requests
      const reqs = await getRequests(user.uid);
      setIncomingRequests(reqs);

      // 2. Fetch fresh profile to get latest connections array
      const freshProfile = await getUser(user.uid);
      const connUids = freshProfile?.connections || [];
      
      if (connUids.length > 0) {
        const cons = await batchUsers(connUids);
        setConnections(cons);
        // 3. Unread counts per connection
        const counts = {};
        await Promise.all(cons.map(async (con) => {
          const roomId = [user.uid, con.uid].sort().join("_");
          const { count } = await getUnreadCount(roomId, user.uid);
          counts[con.uid] = count;
        }));
        setUnreadCounts(counts);
      } else {
        setConnections([]);
      }
    } catch (err) {
      console.error("fetchDashboardData:", err);
    }
  }, [user]);

  useEffect(() => {
    fetchDashboardData();
    const interval = setInterval(fetchDashboardData, 3000);
    return () => clearInterval(interval);
  }, [fetchDashboardData]);

  const acceptRequest = async (request) => {
    try {
      await apiAcceptRequest(request._id || request.id);
      fetchDashboardData(); // refresh immediately
    } catch (error) { console.error("Accept failed:", error); }
  };

  // ── WebRTC helpers ──
  const createPeerConnection = useCallback((toUid) => {
    // Close any existing peer connection first
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    const pc = new RTCPeerConnection(ICE_SERVERS);
    pcRef.current = pc;

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        socketRef.current?.emit("ice-candidate", { candidate, to: toUid });
      }
    };

    pc.ontrack = (event) => {
      console.log("[WebRTC] Remote track received:", event.track.kind);
      if (remoteVideoRef.current && event.streams?.[0]) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    pc.onconnectionstatechange = () => {
      console.log("[WebRTC] Connection state:", pc.connectionState);
      if (pc.connectionState === "connected") {
        setCallState("connected");
      }
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        cleanupCallRef.current?.();
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log("[ICE] Connection state:", pc.iceConnectionState);
      if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        setCallState("connected");
        iceRestartCount.current = 0; // reset on success
      }
      if (pc.iceConnectionState === "failed") {
        if (iceRestartCount.current < 3) {
          iceRestartCount.current++;
          console.warn(`[ICE] Failed — attempting ICE restart #${iceRestartCount.current}`);
          pc.restartIce();
        } else {
          console.error("[ICE] Giving up after 3 restart attempts");
          cleanupCallRef.current?.();
        }
      }
      if (pc.iceConnectionState === "disconnected") {
        // Give a moment before cleanup (could be transient)
        setTimeout(() => {
          if (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed") {
            cleanupCallRef.current?.();
          }
        }, 4000);
      }
    };

    return pc;
  }, []);

  const sendSystemMsg = async (targetChat, text) => {
    const chat = targetChat || selectedChat;
    if (!chat) return;
    const roomId = [user.uid, chat.uid].sort().join("_");
    try { await apiSendMsg({ roomId, senderId: user.uid, text, isSystem: true }); }
    catch (e) { console.error(e); }
  };

  // Called from ChatWindow via onStartCall prop
  const initiateCall = async (type, targetChat) => {
    const chat = targetChat || selectedChat;
    if (!chat) return;
    if (!socketRef.current?.connected) {
      alert("Not connected to server. Please wait a moment and try again.");
      return;
    }
    if (callStateRef.current) return; // already in a call

    const isVideo = type === "video";
    callTypeRef.current = type;
    isInitiator.current = true;
    setIsAudioOnly(!isVideo);
    setCallTarget(chat);
    setCallState("calling");
    pendingIceCandidates.current = [];
    pendingOfferSdp.current = null;
    iceRestartCount.current = 0;
    sendSystemMsg(chat, isVideo ? "🎥 Video Call Started" : "📞 Voice Call Started");

    // Auto-cancel if no answer in 30 seconds
    callTimeoutRef.current = setTimeout(() => {
      if (callStateRef.current === "calling") {
        socketRef.current?.emit("call-ended", { to: chat.uid });
        cleanupCallRef.current?.();
      }
    }, 30000);

    try {
      // Try requested constraints, fall back to audio-only if camera unavailable
      let stream;
      try {
        const constraints = {
          video: isVideo ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } : false,
          audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 },
        };
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        console.warn("[Media] Initial getUserMedia failed, trying fallback:", err);
        stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
        setIsAudioOnly(true);
      }

      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      const pc = createPeerConnection(chat.uid);
      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      // Create offer with specific constraints for cross-device compatibility
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: isVideo,
      });
      await pc.setLocalDescription(offer);

      socketRef.current?.emit("call-user", {
        userToCall: chat.uid,
        from: user.uid,
        name: user.displayName || user.email,
        callType: type,
        signal: { type: "offer", sdp: pc.localDescription.sdp }, // use localDescription (may be modified)
      });
    } catch (err) {
      console.error("[Call] initiateCall failed:", err);
      alert("Could not access camera/microphone. Please allow permissions and try again.");
      setCallState(null);
    }
  };

  const acceptCall = async () => {
    // Don't set 'connected' yet — wait for ICE/connection state
    setCallState("connecting");
    sendSystemMsg(null, callTypeRef.current === "video" ? "🎥 Video Call Connected" : "📞 Voice Call Connected");
    isInitiator.current = false;

    const offerSdp = pendingOfferSdp.current;
    if (!offerSdp) {
      console.error("[Call] No offer SDP stored — cannot accept");
      cleanupCallRef.current?.();
      return;
    }

    try {
      const isVideo = callTypeRef.current === "video";
      let stream;
      try {
        const constraints = {
          video: isVideo ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } : false,
          audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 44100 },
        };
        stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        console.warn("[Media] Fallback to audio-only on accept:", err);
        stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
        setIsAudioOnly(true);
      }

      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;

      const pc = createPeerConnection(callFromRef.current);
      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      // Set the stored offer as remote description
      await pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: offerSdp }));

      // Flush any ICE candidates that arrived before we accepted
      for (const c of pendingIceCandidates.current) {
        await pc.addIceCandidate(new RTCIceCandidate(c)).catch((e) =>
          console.warn("[ICE] flush candidate failed:", e)
        );
      }
      pendingIceCandidates.current = [];
      pendingOfferSdp.current = null;

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      socketRef.current?.emit("answer-call", {
        to: callFromRef.current,
        signal: { type: "answer", sdp: pc.localDescription.sdp },
      });
    } catch (err) {
      console.error("[Call] acceptCall failed:", err);
      cleanupCallRef.current?.();
    }
  };

  const cleanupCall = useCallback(() => {
    console.log("[Call] Cleaning up call");
    clearTimeout(callTimeoutRef.current);
    callTimeoutRef.current = null;
    try { localStreamRef.current?.getTracks().forEach(t => t.stop()); } catch {}
    localStreamRef.current = null;
    try { if (pcRef.current) { pcRef.current.close(); pcRef.current = null; } } catch {}
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    pendingIceCandidates.current = [];
    pendingOfferSdp.current = null;
    isInitiator.current = false;
    callFromRef.current = null;
    iceRestartCount.current = 0;
    setCallState(null);
    setIsMuted(false);
    setIsVideoOff(false);
    setCallTarget(null);
  }, []);

  // Keep cleanupCallRef always pointing to latest cleanupCall
  useEffect(() => { cleanupCallRef.current = cleanupCall; }, [cleanupCall]);

  const endCall = () => {
    clearTimeout(callTimeoutRef.current);
    const toUid = isInitiator.current ? callTarget?.uid : callFromRef.current;
    if (toUid) socketRef.current?.emit("call-ended", { to: toUid });
    if (callStateRef.current === "incoming") {
      // Receiver declined
      socketRef.current?.emit("call-rejected", { to: callFromRef.current });
    }
    sendSystemMsg(null, "📵 Call Ended");
    cleanupCall();
  };

  const toggleMute = () => {
    if (!localStreamRef.current) return;
    const audio = localStreamRef.current.getAudioTracks()[0];
    if (audio) { audio.enabled = !audio.enabled; setIsMuted(!audio.enabled); }
  };

  const toggleVideo = () => {
    if (!localStreamRef.current) return;
    const vid = localStreamRef.current.getVideoTracks()[0];
    if (vid) { vid.enabled = !vid.enabled; setIsVideoOff(!vid.enabled); }
  };

  const shareScreen = async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];
      const sender = pcRef.current?.getSenders().find(s => s.track?.kind === "video");
      if (sender) {
        sender.replaceTrack(screenTrack);
        screenTrack.onended = () => {
          const camTrack = localStreamRef.current?.getVideoTracks()[0];
          if (camTrack) sender.replaceTrack(camTrack);
        };
      }
    } catch { console.log("Screen share cancelled"); }
  };

  // ── Audio control side effect ──
  useEffect(() => {
    if (callState === "incoming") {
      ringtoneRef.current?.play().catch(() => {});
    } else {
      ringtoneRef.current?.pause();
      if (ringtoneRef.current) ringtoneRef.current.currentTime = 0;
    }

    if (callState === "calling") {
      ringingRef.current?.play().catch(() => {});
    } else {
      ringingRef.current?.pause();
      if (ringingRef.current) ringingRef.current.currentTime = 0;
    }
  }, [callState]);

  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#09090b]">
        <div className="h-12 w-12 animate-spin rounded-full border-t-2 border-purple-500" />
      </div>
    );
  }

  return (
    <div className="flex h-[100dvh] bg-[#09090b] text-white overflow-hidden selection:bg-purple-500/30">
      {!profileData?.username && <CompleteProfileModal />}

      {/* Audio assets */}
      <audio ref={ringtoneRef} src="https://assets.mixkit.co/active_storage/sfx/1359/1359-preview.mp3" loop />
      <audio ref={ringingRef} src="https://assets.mixkit.co/active_storage/sfx/1358/1358-preview.mp3" loop />
      <audio ref={notificationRef} src="https://assets.mixkit.co/active_storage/sfx/2358/2358-preview.mp3" />

      {/* Nav Sidebar — hidden on mobile, visible md+ */}
      <nav className="hidden md:flex flex-shrink-0 w-14 md:w-20 flex-col items-center justify-between border-r border-white/5 bg-black py-6">
        <div className="flex flex-col gap-6 items-center">
          <div className="h-8 w-8 md:h-10 md:w-10 flex items-center justify-center rounded-xl bg-gradient-to-tr from-purple-600 to-blue-500">
            <MessageSquare size={18} />
          </div>
          <div className="flex flex-col gap-5 items-center mt-2">
            <NavIcon icon={<MessageSquare size={20} />} active={activeTab === "chats"} onClick={() => setActiveTab("chats")}
              badge={Object.values(unreadCounts).reduce((a, b) => a + b, 0)} />
            <NavIcon icon={<Users size={20} />} active={activeTab === "connections"} onClick={() => setActiveTab("connections")} />
            <NavIcon icon={<Wifi size={20} />} active={activeTab === "online"} onClick={() => setActiveTab("online")} />
          </div>
        </div>
        <div className="flex flex-col gap-5 items-center">
          <NavIcon icon={<Settings size={20} />} active={activeTab === "settings"} onClick={() => setActiveTab("settings")} />
          <button onClick={logout} className="text-zinc-500 hover:text-red-500 transition-colors"><LogOut size={20} /></button>
          <div className="relative">
            <img src={user.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.displayName || user.email || 'U')}&background=7c3aed&color=fff`} alt="" className="h-8 w-8 md:h-9 md:w-9 rounded-full border border-white/10" />
            <span title={socketConnected ? "Connected" : "Connecting..."} className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-black ${socketConnected ? "bg-green-400" : "bg-orange-400 animate-pulse"}`} />
          </div>
        </div>
      </nav>

      {/* Chat List Sidebar */}
      <aside className={`flex-shrink-0 flex-col border-r border-white/5 bg-[#09090b] w-full md:w-72 lg:w-80 ${(selectedChat || activeTab === "settings") ? "hidden md:flex" : "flex"}`}>
        <header className="flex flex-col p-4 gap-4 flex-shrink-0">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold capitalize">{activeTab === "online" ? "Online Now" : activeTab}</h1>
            <div className="flex gap-2">
              <button 
                onClick={() => {
                  if (typeof Notification !== 'undefined') {
                    if (Notification.permission === 'granted') {
                      new Notification("InstaChat", { body: "Notifications are working! ✅", icon: "/icon-192x192.png" });
                    } else {
                      alert(`Notifications are ${Notification.permission}. Enable them in Settings or browser bar.`);
                      Notification.requestPermission();
                    }
                  }
                }}
                title="Test Notification"
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/5 hover:bg-white/10 text-zinc-400"
              >
                <Bell size={16} />
              </button>
              <button onClick={() => setIsSearchOpen(true)} className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-600 hover:bg-purple-700">
                <Plus size={18} />
              </button>
            </div>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" size={15} />
            <input type="text" placeholder="Search..." value={sidebarSearch} onChange={e => setSidebarSearch(e.target.value)}
              className="w-full rounded-xl bg-white/5 py-2.5 pl-9 pr-4 text-sm outline-none focus:ring-1 focus:ring-purple-500" />
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-3 pb-20 md:pb-4 custom-scrollbar">
          {incomingRequests.length > 0 && (
            <div className="mb-4">
              <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold mb-2 flex items-center gap-1 px-1"><Bell size={11} /> Requests</p>
              {incomingRequests.map(req => (
                <div key={req._id || req.id} className="flex items-center justify-between bg-white/5 p-3 rounded-xl border border-white/5 mb-2">
                  <div className="flex items-center gap-2">
                    <img src={req.senderPhoto} className="h-8 w-8 rounded-full" alt="" />
                    <p className="text-xs font-medium">{req.senderName?.split(' ')[0]}</p>
                  </div>
                  <button onClick={() => acceptRequest(req)} className="bg-purple-600 text-[10px] px-3 py-1 rounded-md font-bold hover:bg-purple-700">Accept</button>
                </div>
              ))}
            </div>
          )}

          {activeTab === "chats" && connections
            .filter(con => !sidebarSearch || con.name?.toLowerCase().includes(sidebarSearch.toLowerCase()))
            .map(con => (
              <ChatPreview key={con.uid} name={con.name} photo={con.photoURL} online={con.status === "online"}
                unread={unreadCounts[con.uid] || 0}
                onClick={() => { setSelectedChat(con); setUnreadCounts(p => ({ ...p, [con.uid]: 0 })); }}
                active={selectedChat?.uid === con.uid} />
            ))}
          {activeTab === "chats" && connections.length === 0 && (
            <div className="text-center py-16 opacity-20">
              <MessageSquare className="mx-auto mb-2" size={32} />
              <p className="text-xs">No chats yet</p>
            </div>
          )}
          {activeTab === "connections" && connections.map(con => (
            <div key={con.uid} className="flex items-center justify-between p-3 rounded-xl bg-white/5 border border-white/5 mb-2">
              <div className="flex items-center gap-3">
                <div className="relative">
                  <img src={con.photoURL} className="h-10 w-10 rounded-full" alt="" />
                  {con.status === "online" && <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-[#09090b] bg-green-500" />}
                </div>
                <div>
                  <p className="text-sm font-medium">{con.name}</p>
                  <p className={`text-[10px] ${con.status === "online" ? "text-green-500" : "text-zinc-500"}`}>{con.status === "online" ? "Online" : "Offline"}</p>
                </div>
              </div>
              <button onClick={() => setSelectedChat(con)} className="text-purple-400 hover:text-purple-300">
                <MessageSquare size={18} />
              </button>
            </div>
          ))}
          {activeTab === "online" && (
            connections.filter(c => c.status === "online").length === 0 ? (
              <div className="text-center py-16 opacity-20">
                <Wifi className="mx-auto mb-2" size={32} />
                <p className="text-xs">No one is online</p>
              </div>
            ) : connections.filter(c => c.status === "online").map(con => (
              <div key={con.uid} className="flex items-center gap-3 p-3 rounded-xl bg-white/5 border border-white/5 mb-2 cursor-pointer hover:bg-white/8 transition-colors"
                onClick={() => { setSelectedChat(con); setActiveTab("chats"); }}>
                <div className="relative">
                  <img src={con.photoURL} className="h-11 w-11 rounded-full" alt="" />
                  <span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-[#09090b] bg-green-500 animate-pulse" />
                </div>
                <div>
                  <p className="text-sm font-semibold">{con.name}</p>
                  <p className="text-[10px] text-green-500">● Online now</p>
                </div>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* Main Area */}
      <section className={`flex-1 flex flex-col bg-[#0c0c0e] min-w-0 overflow-hidden ${selectedChat || activeTab === "settings" ? "flex" : "hidden md:flex"}`}>
        {activeTab === "settings" ? (
          <SettingsPanel />
        ) : selectedChat ? (
          <ChatWindow
            selectedChat={selectedChat}
            socket={socket}
            onStartCall={(type) => initiateCall(type, selectedChat)}
            onBack={() => setSelectedChat(null)}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center text-center p-6">
            <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="max-w-sm space-y-4">
              <div className="h-20 w-20 mx-auto flex items-center justify-center rounded-3xl bg-white/5 text-purple-500">
                <MessageSquare size={40} />
              </div>
              <h2 className="text-2xl font-bold">InstaChat</h2>
              <p className="text-zinc-500 text-sm">Select a chat to start messaging or make a call.</p>
            </motion.div>
          </div>
        )}
      </section>

      {/* Mobile Bottom Navigation - Hidden when a chat is active */}
      <nav className={`md:hidden fixed bottom-0 left-0 right-0 z-50 items-center justify-around bg-black/90 backdrop-blur-xl border-t border-white/10 py-3 px-4 safe-area-bottom ${selectedChat ? "hidden" : "flex"}`}>
        <button onClick={() => { setActiveTab("chats"); setSelectedChat(null); }}
          className={`flex flex-col items-center gap-1 transition-colors relative ${activeTab === "chats" && !selectedChat ? "text-purple-400" : "text-zinc-500"}`}>
          <MessageSquare size={22} />
          {Object.values(unreadCounts).reduce((a, b) => a + b, 0) > 0 && (
            <span className="absolute -top-1 -right-2 h-4 min-w-4 px-1 bg-purple-600 rounded-full text-[9px] flex items-center justify-center font-bold text-white">
              {Object.values(unreadCounts).reduce((a, b) => a + b, 0)}
            </span>
          )}
          <span className="text-[10px] font-medium">Chats</span>
        </button>
        <button onClick={() => { setActiveTab("connections"); setSelectedChat(null); }}
          className={`flex flex-col items-center gap-1 transition-colors ${activeTab === "connections" ? "text-purple-400" : "text-zinc-500"}`}>
          <Users size={22} />
          <span className="text-[10px] font-medium">People</span>
        </button>
        <button onClick={() => { setActiveTab("online"); setSelectedChat(null); }}
          className={`flex flex-col items-center gap-1 transition-colors ${activeTab === "online" ? "text-purple-400" : "text-zinc-500"}`}>
          <Wifi size={22} />
          <span className="text-[10px] font-medium">Online</span>
        </button>
        <button onClick={() => { setActiveTab("settings"); setSelectedChat(null); }}
          className={`flex flex-col items-center gap-1 transition-colors ${activeTab === "settings" ? "text-purple-400" : "text-zinc-500"}`}>
          <Settings size={22} />
          <span className="text-[10px] font-medium">Settings</span>
        </button>
        <div className="relative flex flex-col items-center gap-1">
          <img src={user.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.displayName || user.email || 'U')}&background=7c3aed&color=fff`} alt="" className="h-7 w-7 rounded-full border border-white/10" />
          <span className={`absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-black ${socketConnected ? "bg-green-400" : "bg-orange-400 animate-pulse"}`} />
          <span className="text-[10px] font-medium text-zinc-500">Me</span>
        </div>
      </nav>
      <AnimatePresence>
        {callState && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[300] bg-black/95 backdrop-blur-xl flex items-center justify-center p-2 md:p-4">
            <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }}
              className="relative w-full max-w-4xl h-[90vh] md:h-[85vh] bg-[#0c0c0e] rounded-2xl md:rounded-[2.5rem] border border-white/10 overflow-hidden shadow-2xl flex items-center justify-center">

              {/* Remote video */}
              <video ref={remoteVideoRef} autoPlay playsInline
                className={`absolute inset-0 w-full h-full object-cover ${callState !== "connected" || isAudioOnly ? "hidden" : ""}`} />

              {/* Center placeholder */}
              {(isAudioOnly || (callState !== "connected" && callState !== "connecting")) && (
                <div className="flex flex-col items-center gap-4 z-10 text-center px-6">
                  <div className="w-24 h-24 md:w-32 md:h-32 rounded-full overflow-hidden border-4 border-white/10 ring-4 ring-purple-500/30">
                    <img src={callTarget?.photoURL || `https://ui-avatars.com/api/?name=${callTarget?.name}&background=random`} alt="" className="w-full h-full object-cover" />
                  </div>
                  <h2 className="text-xl md:text-2xl font-bold text-white">{callTarget?.name || callerName}</h2>
                  <div className="flex items-center gap-2 text-zinc-400 text-sm">
                    {callState === "calling" && <><span className="h-2 w-2 rounded-full bg-green-400 animate-pulse" /> Ringing...</>}
                    {callState === "incoming" && <><span className="h-2 w-2 rounded-full bg-yellow-400 animate-pulse" /> Incoming {isAudioOnly ? "Voice" : "Video"} Call</>}
                    {callState === "connecting" && <><span className="h-2 w-2 rounded-full bg-yellow-400 animate-pulse" /> Connecting...</>}
                    {callState === "connected" && isAudioOnly && <><span className="h-2 w-2 rounded-full bg-green-400 animate-pulse" /> Call Connected</>}
                  </div>
                </div>
              )}

              {/* Local video (PiP) */}
              <div className={`absolute top-4 right-4 w-28 md:w-40 aspect-video bg-zinc-900 rounded-xl border-2 border-white/20 shadow-xl z-20 overflow-hidden ${isAudioOnly || isVideoOff ? "hidden" : ""}`}>
                <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-full object-cover" style={{ transform: "scaleX(-1)" }} />
              </div>

              {/* Controls */}
              <div className="absolute bottom-6 md:bottom-8 left-1/2 -translate-x-1/2 z-30 flex items-center gap-3 md:gap-4 bg-black/70 backdrop-blur-md px-5 py-3 md:py-4 rounded-2xl border border-white/10">
                {callState === "incoming" ? (
                  <>
                    <button onClick={endCall} className="w-12 h-12 md:w-14 md:h-14 bg-red-500 hover:bg-red-600 rounded-full flex items-center justify-center transition-colors shadow-lg shadow-red-500/30">
                      <PhoneOff size={22} />
                    </button>
                    <button onClick={acceptCall} className="w-12 h-12 md:w-14 md:h-14 bg-green-500 hover:bg-green-600 rounded-full flex items-center justify-center transition-colors shadow-lg shadow-green-500/30 animate-pulse">
                      <Phone size={22} />
                    </button>
                  </>
                ) : (
                  <>
                    <button onClick={toggleMute} className={`w-11 h-11 rounded-full flex items-center justify-center transition-colors ${isMuted ? "bg-red-500/80" : "bg-white/15 hover:bg-white/25"}`}>
                      {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
                    </button>
                    {!isAudioOnly && (
                      <button onClick={toggleVideo} className={`w-11 h-11 rounded-full flex items-center justify-center transition-colors ${isVideoOff ? "bg-red-500/80" : "bg-white/15 hover:bg-white/25"}`}>
                        {isVideoOff ? <VideoOff size={20} /> : <Video size={20} />}
                      </button>
                    )}
                    {!isAudioOnly && (
                      <button onClick={shareScreen} className="hidden md:flex w-11 h-11 bg-blue-500/80 hover:bg-blue-500 rounded-full items-center justify-center transition-colors">
                        <MonitorUp size={20} />
                      </button>
                    )}
                    <button onClick={endCall} className="w-12 h-12 md:w-14 md:h-14 bg-red-500 hover:bg-red-600 rounded-full flex items-center justify-center transition-colors shadow-lg shadow-red-500/30">
                      <PhoneOff size={22} />
                    </button>
                  </>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isSearchOpen && <SearchModal isOpen={isSearchOpen} onClose={() => setIsSearchOpen(false)} />}
      </AnimatePresence>

      {/* ── In-app message toast ── */}
      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.uid}
            initial={{ opacity: 0, y: 24, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.95 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            onClick={() => {
              setSelectedChat(toast.chat);
              setActiveTab("chats");
              setToast(null);
              clearTimeout(toastTimerRef.current);
            }}
            className="fixed bottom-20 md:bottom-6 right-4 z-[400] flex items-center gap-3 bg-[#1a1a1e] border border-white/10 rounded-2xl px-4 py-3 shadow-2xl shadow-black/60 cursor-pointer hover:bg-white/5 transition-colors max-w-xs w-full"
          >
            <div className="relative flex-shrink-0">
              <img
                src={toast.photo || `https://ui-avatars.com/api/?name=${encodeURIComponent(toast.name)}&background=7c3aed&color=fff`}
                alt=""
                className="h-10 w-10 rounded-full object-cover"
              />
              <span className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-purple-500 border-2 border-[#1a1a1e] animate-pulse" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-white truncate">{toast.name}</p>
              <p className="text-xs text-zinc-400 truncate">{toast.text}</p>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); setToast(null); clearTimeout(toastTimerRef.current); }}
              className="text-zinc-600 hover:text-white flex-shrink-0 ml-1"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function NavIcon({ icon, active, onClick, badge }) {
  return (
    <button onClick={onClick}
      className={`relative flex h-10 w-10 md:h-12 md:w-12 items-center justify-center rounded-xl transition-all ${active ? "bg-purple-600/15 text-purple-500" : "text-zinc-500 hover:bg-white/5 hover:text-zinc-300"}`}>
      {active && <motion.div layoutId="nav-active" className="absolute left-0 h-6 w-0.5 rounded-r-full bg-purple-500" />}
      {icon}
      {badge > 0 && (
        <span className="absolute top-1 right-1 h-4 min-w-4 px-1 bg-purple-600 rounded-full text-[9px] flex items-center justify-center font-bold text-white">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}

function ChatPreview({ name, photo, online, onClick, active, unread }) {
  return (
    <button onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-xl p-3 transition-colors ${active ? "bg-purple-600/20 ring-1 ring-purple-600/50" : "hover:bg-white/5"}`}>
      <div className="relative flex-shrink-0">
        <img src={photo} className="h-11 w-11 rounded-full object-cover" alt="" />
        {online && <span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-[#09090b] bg-green-500" />}
      </div>
      <div className="flex-1 text-left min-w-0">
        <h4 className={`font-semibold text-sm truncate ${unread > 0 ? "text-white" : ""}`}>{name}</h4>
        <p className="text-xs text-zinc-500 truncate">{online ? "Online" : "Offline"}</p>
      </div>
      {unread > 0 && (
        <span className="flex-shrink-0 h-5 min-w-5 px-1.5 bg-purple-600 rounded-full text-[10px] flex items-center justify-center font-bold text-white">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  );
}
