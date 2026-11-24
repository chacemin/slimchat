# SlimChat 1v1 语音通话

私聊顶栏电话图标旁选择 `P2P` 或 `TURN`。P2P 仅使用本机/局域网候选地址；约 12 秒未连通时自动重新协商 TURN。TURN 模式强制 `iceTransportPolicy: relay`，不是给直连列表附加一个备用地址。切换会短暂中断声音，保留麦克风、静音状态与通话时长。

## 本地 coturn 配置

跨网段通话需在本机或内网运行 [coturn](https://github.com/coturn/coturn)，监听 `3478/tcp|udp`。SlimChat 不访问任何云端 TURN 签发接口。

静态凭据：

```dotenv
SLIMCHAT_TURN_URL=turn:127.0.0.1:3478
SLIMCHAT_TURN_USERNAME=local
SLIMCHAT_TURN_CREDENTIAL=change-me
```

或使用 coturn `--use-auth-secret` 共享密钥，由服务进程在本地生成短期凭据：

```dotenv
SLIMCHAT_TURN_URL=turns:127.0.0.1:5349
SLIMCHAT_TURN_SHARED_SECRET=change-me
```

`GET /api/calls/:roomId/config` 返回 `turnAvailable`；接听后 `GET /api/calls/:roomId/ice` 返回 ICE 列表。凭据只在本进程与浏览器之间传递，不出公网。

## 安全

- 仅私聊两名成员可通话；任一方被拉黑、禁用或退群后立即拒绝。
- 每用户同时只能占用一个通话席位。
- 振铃 45 秒、最长 1 小时；心跳超时自动结束。
- SDP 与 ICE 通过已鉴权的 `/api/calls/*` 与用户收件箱 WebSocket 传递。
