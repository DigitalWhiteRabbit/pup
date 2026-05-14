"use client";

import { useRef, useCallback, useEffect, useState } from "react";

type PeerState = {
  pc: RTCPeerConnection;
  audioEl: HTMLAudioElement;
  screenEl: HTMLVideoElement | null;
};

type UseWebRTCProps = {
  roomId: string | null;
  workspaceId: string;
  currentUserId: string;
  connected: boolean;
  localStream: MediaStream | null;
  screenStream: MediaStream | null;
  volumes: Record<string, number>; // participantId → 0-100
  participantUserIds: string[]; // userId list of other participants
};

type RemoteScreen = { userId: string; stream: MediaStream };

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

export function useWebRTC({
  roomId,
  workspaceId,
  currentUserId,
  connected,
  localStream,
  screenStream,
  volumes,
  participantUserIds,
}: UseWebRTCProps) {
  const peersRef = useRef<Map<string, PeerState>>(new Map());
  const signalPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(
    new Map(),
  );
  const [remoteScreens, setRemoteScreens] = useState<RemoteScreen[]>([]);

  const base = `/api/workspaces/${workspaceId}/voice/rooms/${roomId}`;

  // Send signal to server
  const sendSignal = useCallback(
    async (toUserId: string, type: string, payload: unknown) => {
      if (!roomId) return;
      await fetch(`${base}/signal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          toUserId,
          type,
          payload: JSON.stringify(payload),
        }),
      });
    },
    [roomId, base],
  );

  // Create peer connection for a remote user
  const createPeer = useCallback(
    (remoteUserId: string, initiator: boolean) => {
      if (peersRef.current.has(remoteUserId))
        return peersRef.current.get(remoteUserId)!;

      const pc = new RTCPeerConnection(ICE_SERVERS);
      const audioEl = new Audio();
      audioEl.autoplay = true;

      // Add local audio tracks
      if (localStream) {
        localStream.getAudioTracks().forEach((track) => {
          pc.addTrack(track, localStream);
        });
      }

      // Add screen share tracks if active
      if (screenStream) {
        screenStream.getTracks().forEach((track) => {
          pc.addTrack(track, screenStream);
        });
      }

      // Handle incoming tracks
      pc.ontrack = (event) => {
        const stream = event.streams[0];
        if (!stream) return;

        if (event.track.kind === "audio") {
          audioEl.srcObject = stream;
        } else if (event.track.kind === "video") {
          setRemoteScreens((prev) => {
            const filtered = prev.filter((s) => s.userId !== remoteUserId);
            return [...filtered, { userId: remoteUserId, stream }];
          });

          event.track.onended = () => {
            setRemoteScreens((prev) =>
              prev.filter((s) => s.userId !== remoteUserId),
            );
          };
        }
      };

      // ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          void sendSignal(
            remoteUserId,
            "ice-candidate",
            event.candidate.toJSON(),
          );
        }
      };

      pc.onconnectionstatechange = () => {
        if (
          pc.connectionState === "failed" ||
          pc.connectionState === "disconnected"
        ) {
          closePeer(remoteUserId);
        }
      };

      const state: PeerState = { pc, audioEl, screenEl: null };
      peersRef.current.set(remoteUserId, state);

      // If initiator, create offer
      if (initiator) {
        void (async () => {
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await sendSignal(
              remoteUserId,
              "offer",
              pc.localDescription?.toJSON(),
            );
          } catch (e) {
            console.error("WebRTC offer error:", e);
          }
        })();
      }

      return state;
    },
    [localStream, screenStream, sendSignal],
  );

  // Close a peer connection
  const closePeer = useCallback((userId: string) => {
    const peer = peersRef.current.get(userId);
    if (peer) {
      peer.pc.close();
      peer.audioEl.srcObject = null;
      peersRef.current.delete(userId);
      setRemoteScreens((prev) => prev.filter((s) => s.userId !== userId));
    }
  }, []);

  // Close all peers
  const closeAll = useCallback(() => {
    for (const [userId] of Array.from(peersRef.current)) {
      closePeer(userId);
    }
    peersRef.current.clear();
    setRemoteScreens([]);
  }, [closePeer]);

  // Process incoming signal
  const handleSignal = useCallback(
    async (signal: { fromUserId: string; type: string; payload: string }) => {
      const { fromUserId, type } = signal;
      let payload: unknown;
      try {
        payload = JSON.parse(signal.payload);
      } catch {
        return;
      }

      if (type === "offer") {
        const peer = createPeer(fromUserId, false);
        if (!peer) return;
        try {
          await peer.pc.setRemoteDescription(
            new RTCSessionDescription(payload as RTCSessionDescriptionInit),
          );
          const answer = await peer.pc.createAnswer();
          await peer.pc.setLocalDescription(answer);
          await sendSignal(
            fromUserId,
            "answer",
            peer.pc.localDescription?.toJSON(),
          );

          // Flush pending ICE candidates
          const pending = pendingCandidatesRef.current.get(fromUserId) ?? [];
          for (const c of pending) {
            await peer.pc.addIceCandidate(new RTCIceCandidate(c));
          }
          pendingCandidatesRef.current.delete(fromUserId);
        } catch (e) {
          console.error("WebRTC answer error:", e);
        }
      } else if (type === "answer") {
        const peer = peersRef.current.get(fromUserId);
        if (peer && peer.pc.signalingState === "have-local-offer") {
          try {
            await peer.pc.setRemoteDescription(
              new RTCSessionDescription(payload as RTCSessionDescriptionInit),
            );

            const pending = pendingCandidatesRef.current.get(fromUserId) ?? [];
            for (const c of pending) {
              await peer.pc.addIceCandidate(new RTCIceCandidate(c));
            }
            pendingCandidatesRef.current.delete(fromUserId);
          } catch (e) {
            console.error("WebRTC set answer error:", e);
          }
        }
      } else if (type === "ice-candidate") {
        const peer = peersRef.current.get(fromUserId);
        if (peer && peer.pc.remoteDescription) {
          try {
            await peer.pc.addIceCandidate(
              new RTCIceCandidate(payload as RTCIceCandidateInit),
            );
          } catch {
            /* ignore */
          }
        } else {
          // Queue candidate
          const q = pendingCandidatesRef.current.get(fromUserId) ?? [];
          q.push(payload as RTCIceCandidateInit);
          pendingCandidatesRef.current.set(fromUserId, q);
        }
      }
    },
    [createPeer, sendSignal],
  );

  // Poll for signals
  useEffect(() => {
    if (!connected || !roomId) return;

    signalPollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`${base}/signal`);
        if (!res.ok) return;
        const signals = (await res.json()) as Array<{
          fromUserId: string;
          type: string;
          payload: string;
        }>;
        for (const sig of signals) {
          await handleSignal(sig);
        }
      } catch {
        /* silent */
      }
    }, 2000);

    return () => {
      if (signalPollRef.current) clearInterval(signalPollRef.current);
    };
  }, [connected, roomId, base, handleSignal]);

  // When participant list changes, create peers for new ones
  useEffect(() => {
    if (!connected) return;

    const otherIds = participantUserIds.filter((id) => id !== currentUserId);

    // Create peers for new participants (we initiate)
    for (const uid of otherIds) {
      if (!peersRef.current.has(uid)) {
        createPeer(uid, true);
      }
    }

    // Close peers that left
    for (const [uid] of Array.from(peersRef.current)) {
      if (!otherIds.includes(uid)) {
        closePeer(uid);
      }
    }
  }, [connected, participantUserIds, currentUserId, createPeer, closePeer]);

  // When screen stream changes, add/remove video tracks on all peers
  useEffect(() => {
    if (!connected) return;

    for (const [, peer] of Array.from(peersRef.current)) {
      const senders = peer.pc.getSenders();
      const videoSender = senders.find((s) => s.track?.kind === "video");

      if (screenStream) {
        const videoTrack = screenStream.getVideoTracks()[0];
        if (videoTrack) {
          if (videoSender) {
            void videoSender.replaceTrack(videoTrack);
          } else {
            peer.pc.addTrack(videoTrack, screenStream);
            // Renegotiate
            void (async () => {
              const offer = await peer.pc.createOffer();
              await peer.pc.setLocalDescription(offer);
              // Find userId for this peer
              for (const [uid, p] of Array.from(peersRef.current)) {
                if (p === peer) {
                  await sendSignal(
                    uid,
                    "offer",
                    peer.pc.localDescription?.toJSON(),
                  );
                  break;
                }
              }
            })();
          }
        }
      } else if (videoSender) {
        peer.pc.removeTrack(videoSender);
      }
    }
  }, [connected, screenStream, sendSignal]);

  // Update audio volumes
  useEffect(() => {
    // volumes is keyed by participant id, but peers are keyed by userId
    // For now, just iterate and try to match
    for (const [, peer] of Array.from(peersRef.current)) {
      if (peer.audioEl) {
        // Default volume 100
        peer.audioEl.volume = 1.0;
      }
    }
    // Apply specific volumes where we can map participantId → userId
    // This is simplified — in production you'd map properly
  }, [volumes]);

  // Cleanup on disconnect
  useEffect(() => {
    if (!connected) {
      closeAll();
    }
  }, [connected, closeAll]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      closeAll();
      if (signalPollRef.current) clearInterval(signalPollRef.current);
    };
  }, [closeAll]);

  return { remoteScreens, closeAll };
}
