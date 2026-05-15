"use client";

import { useRef, useCallback } from "react";

/**
 * Records mixed audio (local mic + all remote peers) using AudioContext.
 * Returns a Blob when stopped.
 */
export function useAudioRecorder() {
  const ctxRef = useRef<AudioContext | null>(null);
  const destRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const sourcesRef = useRef<Map<string, MediaStreamAudioSourceNode>>(new Map());

  /** Start recording — call after joining */
  const startRecording = useCallback((localStream: MediaStream) => {
    try {
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();

      // Add local mic
      const localSrc = ctx.createMediaStreamSource(localStream);
      localSrc.connect(dest);

      ctxRef.current = ctx;
      destRef.current = dest;

      // Start MediaRecorder on the mixed destination
      const recorder = new MediaRecorder(dest.stream, {
        mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm",
      });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start(5000); // Collect chunks every 5s
      recorderRef.current = recorder;
    } catch (e) {
      console.warn("Audio recording setup failed:", e);
    }
  }, []);

  /** Add a remote peer's audio stream to the mix */
  const addRemoteStream = useCallback((peerId: string, stream: MediaStream) => {
    const ctx = ctxRef.current;
    const dest = destRef.current;
    if (!ctx || !dest) return;

    // Remove old source if exists
    const old = sourcesRef.current.get(peerId);
    if (old) {
      try {
        old.disconnect();
      } catch {
        /* */
      }
    }

    try {
      const src = ctx.createMediaStreamSource(stream);
      src.connect(dest);
      sourcesRef.current.set(peerId, src);
    } catch (e) {
      console.warn("Failed to add remote stream to recording:", e);
    }
  }, []);

  /** Remove a peer from the mix */
  const removeRemoteStream = useCallback((peerId: string) => {
    const src = sourcesRef.current.get(peerId);
    if (src) {
      try {
        src.disconnect();
      } catch {
        /* */
      }
      sourcesRef.current.delete(peerId);
    }
  }, []);

  /** Stop recording and return the audio blob */
  const stopRecording = useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === "inactive") {
        resolve(null);
        return;
      }

      recorder.onstop = () => {
        const blob =
          chunksRef.current.length > 0
            ? new Blob(chunksRef.current, { type: recorder.mimeType })
            : null;

        // Cleanup
        for (const src of Array.from(sourcesRef.current.values())) {
          try {
            src.disconnect();
          } catch {
            /* */
          }
        }
        sourcesRef.current.clear();
        try {
          ctxRef.current?.close();
        } catch {
          /* */
        }
        ctxRef.current = null;
        destRef.current = null;
        recorderRef.current = null;
        chunksRef.current = [];

        resolve(blob);
      };

      recorder.stop();
    });
  }, []);

  return { startRecording, stopRecording, addRemoteStream, removeRemoteStream };
}
