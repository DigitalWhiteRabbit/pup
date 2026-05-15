"use client";

import { useRef, useCallback, useEffect, useState } from "react";

type PeerState = {
  pc: RTCPeerConnection;
  audioEl: HTMLAudioElement;
};

type RemoteScreen = { userId: string; stream: MediaStream };

const ICE_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

type Props = {
  signalBase: string; // e.g. /api/workspaces/.../voice/rooms/{roomId}
  currentUserId: string;
  connected: boolean;
  localStream: MediaStream | null;
  screenStream: MediaStream | null;
  peerUserIds: string[]; // other participant userIds (not self)
};

export function useWebRTC({
  signalBase,
  currentUserId: _currentUserId,
  connected,
  localStream,
  screenStream,
  peerUserIds,
}: Props) {
  const peersRef = useRef<Map<string, PeerState>>(new Map());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const iceBuf = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const [remoteScreens, setRemoteScreens] = useState<RemoteScreen[]>([]);

  // Keep ref in sync with prop (so callbacks see latest)
  localStreamRef.current = localStream;

  /* ── helpers ── */

  const signal = useCallback(
    async (to: string, type: string, payload: unknown) => {
      try {
        await fetch(`${signalBase}/signal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            toUserId: to,
            type,
            payload: JSON.stringify(payload),
          }),
        });
      } catch {
        /* silent */
      }
    },
    [signalBase],
  );

  const closePeer = useCallback((uid: string) => {
    const p = peersRef.current.get(uid);
    if (p) {
      p.pc.close();
      p.audioEl.pause();
      p.audioEl.srcObject = null;
      peersRef.current.delete(uid);
    }
    setRemoteScreens((prev) => prev.filter((s) => s.userId !== uid));
  }, []);

  const closeAll = useCallback(() => {
    Array.from(peersRef.current.keys()).forEach(closePeer);
    setRemoteScreens([]);
  }, [closePeer]);

  /* ── create peer ── */

  const makePeer = useCallback(
    (uid: string, isInitiator: boolean) => {
      // Avoid duplicate
      if (peersRef.current.has(uid)) return peersRef.current.get(uid)!;

      const pc = new RTCPeerConnection(ICE_CONFIG);
      const audioEl = new Audio();
      audioEl.autoplay = true;

      // Add local audio
      const stream = localStreamRef.current;
      if (stream) {
        for (const track of stream.getAudioTracks()) {
          pc.addTrack(track, stream);
        }
      }

      // Add screen video if sharing
      if (screenStream) {
        for (const track of screenStream.getTracks()) {
          pc.addTrack(track, screenStream);
        }
      }

      // Remote tracks
      pc.ontrack = (ev) => {
        if (ev.track.kind === "audio") {
          // Create new MediaStream for audio
          const remoteAudio = new MediaStream([ev.track]);
          audioEl.srcObject = remoteAudio;
          void audioEl.play().catch(() => {});
        } else if (ev.track.kind === "video") {
          const remoteVideo = ev.streams[0] ?? new MediaStream([ev.track]);
          setRemoteScreens((prev) => [
            ...prev.filter((s) => s.userId !== uid),
            { userId: uid, stream: remoteVideo },
          ]);
          ev.track.onended = () => {
            setRemoteScreens((prev) => prev.filter((s) => s.userId !== uid));
          };
        }
      };

      // ICE
      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          void signal(uid, "ice-candidate", ev.candidate.toJSON());
        }
      };

      pc.onconnectionstatechange = () => {
        if (
          pc.connectionState === "failed" ||
          pc.connectionState === "closed"
        ) {
          closePeer(uid);
        }
      };

      const state: PeerState = { pc, audioEl };
      peersRef.current.set(uid, state);

      if (isInitiator) {
        void (async () => {
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            if (pc.localDescription) {
              await signal(uid, "offer", pc.localDescription.toJSON());
            }
          } catch (e) {
            console.warn("WebRTC offer failed:", e);
          }
        })();
      }

      return state;
    },
    [screenStream, signal, closePeer],
  );

  /* ── process signal ── */

  const processSignal = useCallback(
    async (from: string, type: string, raw: string) => {
      let payload: RTCSessionDescriptionInit | RTCIceCandidateInit;
      try {
        payload = JSON.parse(raw);
      } catch {
        return;
      }

      if (type === "offer") {
        // Someone sent us an offer — create peer (non-initiator), answer
        closePeer(from); // Clean up stale peer if any
        const p = makePeer(from, false);
        try {
          await p.pc.setRemoteDescription(
            new RTCSessionDescription(payload as RTCSessionDescriptionInit),
          );

          const answer = await p.pc.createAnswer();
          await p.pc.setLocalDescription(answer);
          if (p.pc.localDescription) {
            await signal(from, "answer", p.pc.localDescription.toJSON());
          }

          // Flush buffered ICE
          const buf = iceBuf.current.get(from) ?? [];
          for (const c of buf) {
            try {
              await p.pc.addIceCandidate(new RTCIceCandidate(c));
            } catch {
              /* */
            }
          }
          iceBuf.current.delete(from);
        } catch (e) {
          console.warn("WebRTC answer failed:", e);
        }
      } else if (type === "answer") {
        const p = peersRef.current.get(from);
        if (!p) return;
        try {
          if (p.pc.signalingState === "have-local-offer") {
            await p.pc.setRemoteDescription(
              new RTCSessionDescription(payload as RTCSessionDescriptionInit),
            );
          }
          // Flush buffered ICE
          const buf = iceBuf.current.get(from) ?? [];
          for (const c of buf) {
            try {
              await p.pc.addIceCandidate(new RTCIceCandidate(c));
            } catch {
              /* */
            }
          }
          iceBuf.current.delete(from);
        } catch (e) {
          console.warn("WebRTC set-answer failed:", e);
        }
      } else if (type === "ice-candidate") {
        const p = peersRef.current.get(from);
        if (p && p.pc.remoteDescription) {
          try {
            await p.pc.addIceCandidate(
              new RTCIceCandidate(payload as RTCIceCandidateInit),
            );
          } catch {
            /* */
          }
        } else {
          // Buffer until remote description is set
          const buf = iceBuf.current.get(from) ?? [];
          buf.push(payload as RTCIceCandidateInit);
          iceBuf.current.set(from, buf);
        }
      }
    },
    [makePeer, signal, closePeer],
  );

  /* ── poll signals ── */

  useEffect(() => {
    if (!connected || !signalBase) {
      if (pollRef.current) clearInterval(pollRef.current);
      return;
    }

    // Poll every 1.5s for lower latency during connection setup
    const poll = async () => {
      try {
        const res = await fetch(`${signalBase}/signal`);
        if (!res.ok) return;
        const signals = (await res.json()) as Array<{
          fromUserId: string;
          type: string;
          payload: string;
        }>;
        for (const s of signals) {
          await processSignal(s.fromUserId, s.type, s.payload);
        }
      } catch {
        /* */
      }
    };

    // Initial poll immediately
    void poll();
    pollRef.current = setInterval(() => void poll(), 1500);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [connected, signalBase, processSignal]);

  /* ── react to participant changes: initiate connections ── */

  useEffect(() => {
    if (!connected || !localStream) return;

    // Create peers for participants we don't have yet
    for (const uid of peerUserIds) {
      if (!peersRef.current.has(uid)) {
        makePeer(uid, true);
      }
    }

    // Close peers for participants that left
    for (const uid of Array.from(peersRef.current.keys())) {
      if (!peerUserIds.includes(uid)) {
        closePeer(uid);
      }
    }
  }, [connected, localStream, peerUserIds, makePeer, closePeer]);

  /* ── cleanup on disconnect / unmount ── */

  useEffect(() => {
    if (!connected) {
      closeAll();
      iceBuf.current.clear();
    }
  }, [connected, closeAll]);

  useEffect(() => {
    return () => {
      closeAll();
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [closeAll]);

  return { remoteScreens };
}
