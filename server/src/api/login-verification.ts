export function registerLoginVerificationPublicRoutes(app) {
  app.get('/api/auth/verification', (c) => {
    c.header('Cache-Control', 'no-store');
    // 本地访问口令门槛由 .env 控制，不再依赖任何外部验证服务。
    return c.json({ enabled: Boolean(c.env.CONFIG?.loginGateEnabled), siteKey: '' });
  });
}
