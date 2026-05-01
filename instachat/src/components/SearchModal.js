"use client";

import { useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { searchUsers, sendRequest as apiSendRequest, getRecommendations } from "@/lib/api";
import { motion, AnimatePresence } from "framer-motion";
import { Search, X, UserPlus, Check, Loader2, Users } from "lucide-react";
import { useEffect } from "react";

export default function SearchModal({ isOpen, onClose }) {
  const [searchTerm,   setSearchTerm]   = useState("");
  const [results,      setResults]      = useState([]);
  const [loading,      setLoading]      = useState(false);
  const [requestSent,  setRequestSent]  = useState({});
  const [recommendations, setRecommendations] = useState([]);
  const [loadingRecs, setLoadingRecs] = useState(false);
  const { user, profileData } = useAuth();

  useEffect(() => {
    if (isOpen && user?.uid && !searchTerm) {
      const loadRecs = async () => {
        setLoadingRecs(true);
        try {
          const recs = await getRecommendations(user.uid);
          setRecommendations(recs);
        } catch (error) {
          console.error("Failed to load recommendations:", error);
        } finally {
          setLoadingRecs(false);
        }
      };
      loadRecs();
    }
  }, [isOpen, user, searchTerm]);

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!searchTerm.trim()) return;
    setLoading(true);
    try {
      const users = await searchUsers(searchTerm.trim(), user.uid);
      setResults(users);
    } catch (error) {
      console.error("Search error:", error);
    } finally {
      setLoading(false);
    }
  };

  const sendRequest = async (receiver) => {
    if (!receiver.uid) return;
    try {
      await apiSendRequest({
        senderId:       user.uid,
        senderName:     profileData?.name || user.displayName,
        senderPhoto:    user.photoURL,
        senderUsername: profileData?.username || "",
        receiverId:     receiver.uid,
      });
      setRequestSent(prev => ({ ...prev, [receiver.uid]: true }));
    } catch (error) {
      console.error("Request failed:", error);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.9, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.9, y: 20 }}
        className="w-full max-w-md rounded-t-3xl sm:rounded-3xl border border-white/10 bg-[#121214] p-6 sm:p-8 shadow-2xl"
      >
        <div className="mb-6 flex items-center justify-between">
          <h2 className="text-xl font-bold">Find Friends</h2>
          <button onClick={onClose} className="rounded-full p-2 hover:bg-white/5 transition-colors">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSearch} className="relative mb-8">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500" size={18} />
          <input
            autoFocus
            type="text"
            placeholder="Search by email or @username..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full rounded-2xl bg-white/5 py-4 pl-12 pr-4 outline-none ring-1 ring-white/10 transition-all focus:ring-purple-500"
          />
          {loading && <Loader2 className="absolute right-4 top-1/2 -translate-y-1/2 animate-spin text-purple-500" size={18} />}
        </form>

        <div className="space-y-4 max-h-[40vh] sm:max-h-[300px] overflow-y-auto custom-scrollbar">
          {!searchTerm ? (
            <div className="space-y-4">
              <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-widest flex items-center gap-2 mb-2">
                <Users size={16} /> Suggested People
              </h3>
              {loadingRecs ? (
                <div className="flex justify-center py-8"><Loader2 className="animate-spin text-purple-500" /></div>
              ) : recommendations.length > 0 ? (
                recommendations.map((res) => (
                  <div key={res.uid} className="flex items-center justify-between rounded-2xl bg-white/5 p-4 border border-transparent hover:border-white/5 transition-all">
                    <div className="flex items-center gap-3">
                      <img src={res.photoURL} className="h-10 w-10 rounded-full" alt="" />
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-semibold text-sm">{res.name}</p>
                          {res.username && (
                            <span className="text-[10px] bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded-full font-bold">@{res.username}</span>
                          )}
                        </div>
                        {res.mutualCount > 0 ? (
                          <p className="text-xs text-purple-400 font-medium mt-0.5">{res.mutualCount} mutual connection{res.mutualCount > 1 ? 's' : ''}</p>
                        ) : (
                          <p className="text-xs text-zinc-500 mt-0.5">{res.email}</p>
                        )}
                      </div>
                    </div>
                    {requestSent[res.uid] ? (
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-500/10 text-green-500">
                        <Check size={20} />
                      </div>
                    ) : (
                      <button
                        onClick={() => sendRequest(res)}
                        className="flex h-10 w-10 items-center justify-center rounded-full bg-purple-600 text-white hover:bg-purple-700 transition-all shadow-lg shadow-purple-500/20"
                      >
                        <UserPlus size={20} />
                      </button>
                    )}
                  </div>
                ))
              ) : (
                <p className="text-center text-zinc-500 py-4">No suggestions available.</p>
              )}
            </div>
          ) : results.length > 0 ? (
            results.map((res) => (
              <div key={res.uid} className="flex items-center justify-between rounded-2xl bg-white/5 p-4 border border-transparent hover:border-white/5 transition-all">
                <div className="flex items-center gap-3">
                  <img src={res.photoURL} className="h-10 w-10 rounded-full" alt="" />
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-sm">{res.name}</p>
                      {res.username && (
                        <span className="text-[10px] bg-purple-500/20 text-purple-400 px-2 py-0.5 rounded-full font-bold">@{res.username}</span>
                      )}
                    </div>
                    <p className="text-xs text-zinc-500">{res.email}</p>
                  </div>
                </div>
                {requestSent[res.uid] ? (
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-500/10 text-green-500">
                    <Check size={20} />
                  </div>
                ) : (
                  <button
                    onClick={() => sendRequest(res)}
                    className="flex h-10 w-10 items-center justify-center rounded-full bg-purple-600 text-white hover:bg-purple-700 transition-all shadow-lg shadow-purple-500/20"
                  >
                    <UserPlus size={20} />
                  </button>
                )}
              </div>
            ))
          ) : !loading && (
            <p className="text-center text-zinc-500 py-4">No users found.</p>
          )}
        </div>
      </motion.div>
    </div>
  );
}
