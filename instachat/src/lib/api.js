// Central API helper for all MongoDB backend calls
// Firebase is ONLY used for authentication — all data goes through here.

const BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';

async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `API error ${res.status}`);
  }
  return res.json();
}

// ── Users ──────────────────────────────────────────────
export const createUser    = (data)       => api('/api/users', { method: 'POST', body: JSON.stringify(data) });
export const getUser       = (uid)        => api(`/api/users/${uid}`);
export const updateUser    = (uid, data)  => api(`/api/users/${uid}`, { method: 'PATCH', body: JSON.stringify(data) });
export const searchUsers   = (term, selfUid) => api(`/api/users/search/${encodeURIComponent(term)}?selfUid=${selfUid}`);
export const checkUsername = (username)   => api(`/api/users/username/${username}`);
export const batchUsers    = (uids)       => api('/api/users/batch', { method: 'POST', body: JSON.stringify({ uids }) });

// ── Requests ───────────────────────────────────────────
export const getRequests   = (uid)  => api(`/api/requests/${uid}`);
export const sendRequest   = (data) => api('/api/requests', { method: 'POST', body: JSON.stringify(data) });
export const acceptRequest = (id)   => api(`/api/requests/${id}/accept`, { method: 'PATCH' });

// ── Messages ───────────────────────────────────────────
export const getMessages      = (roomId)             => api(`/api/messages/${roomId}`);
export const sendMessage      = (data)               => api('/api/messages', { method: 'POST', body: JSON.stringify(data) });
export const updateMsgStatus  = (id, status)         => api(`/api/messages/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
export const markRoomRead     = (roomId, readerUid)  => api(`/api/messages/read-room/${roomId}`, { method: 'PATCH', body: JSON.stringify({ readerUid }) });
export const reactToMessage   = (id, uid, emoji)     => api(`/api/messages/${id}/react`, { method: 'PATCH', body: JSON.stringify({ uid, emoji }) });
export const deleteMessage    = (id)                 => api(`/api/messages/${id}`, { method: 'DELETE' });
export const getUnreadCount   = (roomId, uid)        => api(`/api/messages/unread/${roomId}/${uid}`);
// ── Rooms ──────────────────────────────────────────────
export const getRoom    = (roomId)       => api(`/api/rooms/${roomId}`);
export const updateRoom = (roomId, data) => api(`/api/rooms/${roomId}`, { method: 'PATCH', body: JSON.stringify(data) });
