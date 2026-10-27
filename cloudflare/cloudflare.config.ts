import { bindings, defineConfig } from 'cf/config';

export default defineConfig({
  accountId: '8ee70c4b6325ecf3bdc84838281a61f4',
  worker: {
    name: 'nappy',
    entrypoint: '../worker.js',
    compatibilityDate: '2026-10-26',
    workersDev: true,
    domains: ['sleepy.elipleaner.com'],
    assets: { notFoundHandling: 'single-page-application', runWorkerFirst: ['/api/*'] },
    env: {
      ASSETS: bindings.assets(),
      DB: bindings.d1({ id: '5559540f-65d9-4a0f-9676-9ff37fee87d5', name: 'epleaner-nappy' }),
    },
    observability: { enabled: false },
  },
});
