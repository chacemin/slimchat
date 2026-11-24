type ProbeResult = { status: 'completed' | 'timeout' | 'unsupported' | 'failed'; ips: string[] };

export function probeWebRtc({ signal, timeoutMs = 2000, PeerConnection = globalThis.RTCPeerConnection }:
  { signal: AbortSignal; timeoutMs?: number; PeerConnection?: typeof RTCPeerConnection }): Promise<ProbeResult> {
  if (!PeerConnection) return Promise.resolve({ status: 'unsupported', ips: [] });
  if (signal.aborted) return Promise.resolve({ status: 'failed', ips: [] });
  return new Promise((resolve) => {
    let peer: RTCPeerConnection;
    let timer: ReturnType<typeof setTimeout>;
    let settled = false;
    const ips = new Set<string>();
    const finish = (status: ProbeResult['status']) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      if (peer) {
        peer.onicecandidate = null;
        peer.close();
      }
      resolve({ status, ips: status === 'failed' ? [] : [...ips] });
    };
    const cancel = () => finish('failed');
    try {
      // 纯本地部署不访问公网 STUN；探测仅用于可选的登录网络提示。
      peer = new PeerConnection({ iceServers: [], iceCandidatePoolSize: 0 });
      signal.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => finish('timeout'), timeoutMs);
      peer.onicecandidate = ({ candidate }) => {
        if (!candidate) return finish('completed');
        if (candidate.type === 'srflx' && candidate.address && ips.size < 4) ips.add(candidate.address);
      };
      peer.createDataChannel('network-check');
      void peer.createOffer().then((offer) => {
        if (!settled) return peer.setLocalDescription(offer);
      }).catch(() => finish('failed'));
    } catch {
      finish('failed');
    }
  });
}
