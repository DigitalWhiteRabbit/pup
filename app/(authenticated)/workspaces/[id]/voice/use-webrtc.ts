"use client";

import { useRef, useCallback, useEffect, useState } from "react";

type PeerState = {
  pc: RTCPeerConnection;
  audioEl: HTMLAudioElement;
  analyser: AnalyserNode | null;
  analyserData: Uint8Array<ArrayBuffer> | null;
};

type RemoteScreen = { userId: string; stream: MediaStream };

// Fetched from /api/voice/ice-servers (includes TURN if configured)
let _iceConfigCache: RTCConfiguration | null = null;
let _iceConfigFetching = false;

async function getIceConfig(): Promise<RTCConfiguration> {
  if (_iceConfigCache) return _iceConfigCache;
  if (_iceConfigFetching) {
    // Wait for in-flight fetch
    await new Promise((r) => setTimeout(r, 500));
    return (
      _iceConfigCache ?? {
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      }
    );
  }
  _iceConfigFetching = true;
  try {
    const res = await fetch("/api/voice/ice-servers");
    if (res.ok) {
      const data = (await res.json()) as { iceServers: RTCIceServer[] };
      _iceConfigCache = { iceServers: data.iceServers };
    }
  } catch {
    /* fallback */
  }
  _iceConfigFetching = false;
  return (
    _iceConfigCache ?? {
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    }
  );
}

type Props = {
  signalBase: string;
  currentUserId: string;
  connected: boolean;
  localStream: MediaStream | null;
  screenStream: MediaStream | null;
  peerUserIds: string[];
  onRemoteAudio?: (peerId: string, stream: MediaStream) => void;
  onPeerLeft?: (peerId: string) => void;
};

export function useWebRTC({
  signalBase,
  currentUserId: _currentUserId,
  connected,
  localStream,
  screenStream,
  peerUserIds,
  onRemoteAudio,
  onPeerLeft,
}: Props) {
  const peersRef = useRef<Map<string, PeerState>>(new Map());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const iceBuf = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const [remoteScreens, setRemoteScreens] = useState<RemoteScreen[]>([]);
  const [speakingPeers, setSpeakingPeers] = useState<Set<string>>(new Set());
  const speakingCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  const closePeer = useCallback(
    (uid: string) => {
      const p = peersRef.current.get(uid);
      if (p) {
        p.pc.close();
        p.audioEl.pause();
        p.audioEl.srcObject = null;
        peersRef.current.delete(uid);
      }
      onPeerLeft?.(uid);
      setRemoteScreens((prev) => prev.filter((s) => s.userId !== uid));
    },
    [onPeerLeft],
  );

  const closeAll = useCallback(() => {
    Array.from(peersRef.current.keys()).forEach(closePeer);
    setRemoteScreens([]);
  }, [closePeer]);

  /* ── create peer ── */

  const makePeerAsync = useCallback(
    async (uid: string, isInitiator: boolean) => {
      // Avoid duplicate
      if (peersRef.current.has(uid)) return peersRef.current.get(uid)!;

      const iceConfig = await getIceConfig();
      const pc = new RTCPeerConnection(iceConfig);
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
          const remoteAudio = new MediaStream([ev.track]);
          audioEl.srcObject = remoteAudio;
          void audioEl.play().catch(() => {});
          // Setup speaking analyser for this peer
          try {
            const actx = new AudioContext();
            const src = actx.createMediaStreamSource(remoteAudio);
            const analyser = actx.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.5;
            src.connect(analyser);
            state.analyser = analyser;
            state.analyserData = new Uint8Array(analyser.frequencyBinCount);
          } catch {
            /* no AudioContext */
          }
          // Notify recorder about remote audio
          onRemoteAudio?.(uid, remoteAudio);
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

      const state: PeerState = {
        pc,
        audioEl,
        analyser: null,
        analyserData: null,
      };
      peersRef.current.set(uid, state);

      if (isInitiator) {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          if (pc.localDescription) {
            await signal(uid, "offer", pc.localDescription.toJSON());
          }
        } catch (e) {
          console.warn("WebRTC offer failed:", e);
        }
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
        const p = await makePeerAsync(from, false);
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
    [makePeerAsync, signal, closePeer],
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
        void makePeerAsync(uid, true);
      }
    }

    // Close peers for participants that left
    for (const uid of Array.from(peersRef.current.keys())) {
      if (!peerUserIds.includes(uid)) {
        closePeer(uid);
      }
    }
  }, [connected, localStream, peerUserIds, makePeerAsync, closePeer]);

  /* ── speaking detection for remote peers ── */

  useEffect(() => {
    if (!connected) {
      if (speakingCheckRef.current) clearInterval(speakingCheckRef.current);
      setSpeakingPeers(new Set());
      return;
    }

    speakingCheckRef.current = setInterval(() => {
      const speaking = new Set<string>();
      for (const [uid, peer] of Array.from(peersRef.current)) {
        if (peer.analyser && peer.analyserData) {
          peer.analyser.getByteFrequencyData(peer.analyserData);
          const avg =
            peer.analyserData.reduce((a, b) => a + b, 0) /
            peer.analyserData.length;
          if (avg > 12) speaking.add(uid);
        }
      }
      setSpeakingPeers(speaking);
    }, 200);

    return () => {
      if (speakingCheckRef.current) clearInterval(speakingCheckRef.current);
    };
  }, [connected]);

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
      if (speakingCheckRef.current) clearInterval(speakingCheckRef.current);
    };
  }, [closeAll]);

  return { remoteScreens, speakingPeers };
}
