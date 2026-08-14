import { ApiVideoClient } from './apivideo/client.js';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();

  // Fail fast on a bad key: better a refused startup than a control page that
  // 502s on every action. A *missing* key is a supported mode — see app.ts.
  if (config.apiVideoKey) {
    const client = new ApiVideoClient({
      apiKey: config.apiVideoKey,
      environment: config.apiVideoEnv,
      ...(config.apiVideoBaseUrl ? { baseUrl: config.apiVideoBaseUrl } : {}),
    });
    await client.authenticate();
  }

  const app = await buildApp({ config });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'shutting down');
      void app.close().then(() => process.exit(0));
    });
  }

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    { probeUrl: `${config.publicBaseUrl ?? `http://localhost:${config.port}`}/probe/` },
    'probe page ready',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
