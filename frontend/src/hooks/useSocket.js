// src/hooks/useSocket.js
import { useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';

export function useSocket(handlers) {
  const socketRef = useRef(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const socket = io(window.location.origin, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10,
      reconnectionDelay: 2000,
    });

    socketRef.current = socket;

    socket.on('connect', () => handlersRef.current.onConnect?.());
    socket.on('disconnect', () => handlersRef.current.onDisconnect?.());
    socket.on('initial:state', data => handlersRef.current.onInitialState?.(data));
    socket.on('provider:updated', data => handlersRef.current.onProviderUpdated?.(data));
    socket.on('provider:fetching', data => handlersRef.current.onProviderFetching?.(data));
    socket.on('provider:error', data => handlersRef.current.onProviderError?.(data));
    socket.on('provider:disconnected', data => handlersRef.current.onProviderDisconnected?.(data));
    socket.on('alerts:updated', data => handlersRef.current.onAlertsUpdated?.(data));
    socket.on('topology:updated', data => handlersRef.current.onTopologyUpdated?.(data));

    return () => socket.disconnect();
  }, []);

  const emit = useCallback((event, data) => {
    socketRef.current?.emit(event, data);
  }, []);

  return { emit };
}
